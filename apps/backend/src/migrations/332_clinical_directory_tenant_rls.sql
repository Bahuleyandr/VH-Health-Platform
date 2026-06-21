-- 332_clinical_directory_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH (facility directory).
--
-- The clinical directory / facility-config tables had NO tenant_id / RLS:
--   * staff        — staff directory (employee_id, name, role)
--   * doctors       — doctor directory (department_id)
--   * departments    — facility departments
--   * wards           — inpatient wards (department_id)
-- These are top-level facility entities with no tenant-bearing parent, so
-- every existing row is the single (default) tenant — Pattern A with a
-- default-tenant backfill is correct; new rows get the GUC-reading DEFAULT.
-- (This is the migration that finally tenant-scopes `staff`; mig 330 had to
-- backfill the payroll cluster to the default tenant for exactly this
-- reason — those rows are already correctly the default tenant.)
--
-- UNIQUE work (verified against live QA schema, mig tip 331):
--   * staff.employee_id — had NO uniqueness contract at all (nullable; 0
--     NULLs / 0 duplicates in current data). Add the per-tenant unique the
--     directory needs: (tenant_id, employee_id) WHERE employee_id IS NOT
--     NULL (partial — exempts the "unassigned" NULLs).
--   * departments.name — was GLOBAL unique (departments_name_key, a
--     standalone INDEX, no FK depends on it). Swap to (tenant_id, name):
--     two hospitals may both have a "Cardiology" department.
--
-- Mirrors migration 239 (multi-table Pattern A) + 326 (uniq_<t>_tenant_<col>).

BEGIN;

-- ---------------------------------------------------------------------------
-- Pattern A on the 4 directory tables (default-tenant backfill).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY['staff','doctors','departments','wards'];
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
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

    RAISE NOTICE 'Tenant-isolated % (tenant_id + RLS + policy)', t;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- staff.employee_id — add the per-tenant uniqueness contract (new).
-- ---------------------------------------------------------------------------
DO $$
DECLARE clash RECORD;
BEGIN
  SELECT tenant_id, employee_id, count(*) AS n INTO clash
    FROM staff WHERE employee_id IS NOT NULL
   GROUP BY tenant_id, employee_id HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'staff has % rows sharing (tenant_id=%, employee_id=%); dedupe before migration 332',
      clash.n, clash.tenant_id, clash.employee_id;
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_tenant_employee_id
  ON staff (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- departments.name — global unique -> per-tenant.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS departments_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_departments_tenant_name
  ON departments (tenant_id, name);

COMMIT;
