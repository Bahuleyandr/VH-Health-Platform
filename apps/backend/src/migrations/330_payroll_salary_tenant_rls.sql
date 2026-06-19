-- 330_payroll_salary_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH (staff PII / money).
--
-- The payroll/salary cluster (14 tables) had NO tenant_id / RLS — staff
-- salaries, payslips, advances, settlements, tax summaries and the billing
-- line-item/advance children were all cross-tenant readable/writable.
-- Pattern A: add tenant_id + ENABLE/FORCE RLS + the canonical
-- tenant_isolation policy + the GUC-reading DEFAULT (post-310 standard).
--
-- BACKFILL SOURCES (verified against live QA schema, mig tip 329):
--   * billing_invoice_items, billing_advance_settlements — backfill via the
--     parent billing_invoices.tenant_id (invoice_id is NOT NULL -> always
--     resolves). This is the authoritative parent and stays correct if the
--     data is ever already multi-tenant.
--   * the 12 staff-payroll tables — these key by staff_uid, but `staff`
--     does NOT carry tenant_id yet (that lands in migration 332), so a
--     staff-join backfill is impossible here. Every existing payroll row is
--     single-tenant (the default tenant), so backfilling to the default
--     tenant is correct for current data; NEW rows get their tenant from the
--     GUC-reading DEFAULT. (When `staff` becomes tenant-scoped in 332 the
--     existing rows are already correctly the default tenant.)
--
-- UNIQUE swaps (Pattern B) — only the genuinely global ones:
--   * payroll_runs (month, year) -> (tenant_id, month, year): a run header
--     is NOT staff-scoped, so two tenants both running e.g. 2026-03 payroll
--     would collide (23505) without this.
--   * salary_revisions (revision_number) -> (tenant_id, revision_number): a
--     per-tenant human document number (W2 spec lists this under 336, but it
--     is folded in here since tenant_id is added to the table in THIS
--     migration — keeps all salary_revisions changes cohesive and removes a
--     global-unique-that-breaks-on-tenant-2 a wave earlier). 336 no longer
--     handles it.
--   The staff_uid-keyed uniques (staff_salary.staff_uid,
--   payslips(staff_uid,month,year), annual_tax_summaries(staff_uid,fy),
--   investment_declarations(staff_uid,fy)) are ALREADY naturally per-tenant
--   (a staff_uid belongs to exactly one tenant) and are left unchanged.
--
-- Both target uniques are standalone INDEXES (DROP INDEX); no FK references
-- either column. Mirrors migrations 239 (multi-table Pattern A) + 328 (GUC
-- default) + 326 (uniq_<table>_tenant_<col>).

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: add tenant_id to all 14 tables (idempotent).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'payslips','payroll_runs','staff_salary','salary_advances','salary_arrears',
    'salary_revisions','leave_encashments','full_final_settlements','advance_deductions',
    'annual_tax_summaries','investment_declarations','bulk_revision_jobs',
    'billing_invoice_items','billing_advance_settlements'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 2: backfill the two billing children from their parent invoice.
-- ---------------------------------------------------------------------------
UPDATE billing_invoice_items x
   SET tenant_id = COALESCE(bi.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM billing_invoices bi
 WHERE x.tenant_id IS NULL AND bi.id = x.invoice_id;

UPDATE billing_advance_settlements x
   SET tenant_id = COALESCE(bi.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid)
  FROM billing_invoices bi
 WHERE x.tenant_id IS NULL AND bi.id = x.invoice_id;

-- ---------------------------------------------------------------------------
-- Step 3: coerce every remaining NULL (the 12 staff tables + any billing
-- orphan) to the default tenant, then finalize NOT NULL + GUC DEFAULT + FK
-- + index uniformly for all 14.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'payslips','payroll_runs','staff_salary','salary_advances','salary_arrears',
    'salary_revisions','leave_encashments','full_final_settlements','advance_deductions',
    'annual_tax_summaries','investment_declarations','bulk_revision_jobs',
    'billing_invoice_items','billing_advance_settlements'
  ];
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001''::uuid WHERE tenant_id IS NULL', t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT %s', t, default_expr
    );
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('fk_%s_tenant', t)) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION',
        t, format('fk_%s_tenant', t)
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', format('idx_%s_tenant_id', t), t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 4: ENABLE + FORCE RLS + canonical tenant_isolation policy on all 14.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'payslips','payroll_runs','staff_salary','salary_advances','salary_arrears',
    'salary_revisions','leave_encashments','full_final_settlements','advance_deductions',
    'annual_tax_summaries','investment_declarations','bulk_revision_jobs',
    'billing_invoice_items','billing_advance_settlements'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 5: Pattern B — tenant-scope the two genuinely-global uniques.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS payroll_runs_month_year_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_runs_tenant_month_year
  ON payroll_runs (tenant_id, month, year);

DROP INDEX IF EXISTS salary_revisions_revision_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_salary_revisions_tenant_revision_number
  ON salary_revisions (tenant_id, revision_number);

COMMIT;
