-- 329_doc_number_uniques_per_tenant.sql
--
-- W2 (multi-tenancy program) — schema completeness, BLOCKER + HIGH.
--
-- ~20 human-facing document-number identifiers were enforced UNIQUE
-- GLOBALLY (across all tenants), so the *first* document tenant #2 mints
-- whose number already exists in tenant #1 throws 23505 — a hard failure
-- the moment a second hospital onboards. Each of these tables ALREADY
-- carries NOT NULL tenant_id (added in earlier RLS phases), so the fix is
-- Pattern B: drop the global unique and re-add it tenant-scoped
-- (tenant_id, <col>). SAFE on existing single-tenant data — every current
-- row is the default tenant and the OLD global unique guarantees no
-- (tenant_id, <col>) collision can exist, so the new index builds cleanly.
--
-- Verified against the live QA schema (mig tip 328) before writing:
--
--  * OBJECT KIND. The QA lineage had 19 standalone UNIQUE INDEXES and one
--    UNIQUE CONSTRAINT, but older deployed lineages may represent additional
--    objects as constraints. The tuple records the expected QA kind for drift
--    evidence; the live pg_constraint catalog is authoritative for dropping.
--
--  * NULLABILITY. 17 target columns are NOT NULL -> plain composite
--    UNIQUE (tenant_id, col). 3 are nullable (appointments.visit_no,
--    billing_invoices.invoice_number, investigation_bookings.booking_number)
--    -> partial UNIQUE (tenant_id, col) WHERE col IS NOT NULL, so the
--    "unassigned" NULLs stay exempt (matches the mig-326 idiom and the
--    pre-existing visit_no partial index this replaces).
--
--  * NO FK DEPENDENCY. Confirmed zero foreign keys reference any of these
--    columns, so dropping the uniques cannot fail on a dependency.
--
-- DELIBERATELY EXCLUDED:
--  * investigations.sample_barcode  ('INV-<id36>-<rand>')
--  * pharmacy_orders.pack_barcode   ('VHMP-<orderId>-<token>')
--    Both embed the GLOBAL SERIAL id, so they are globally-unique BY
--    CONSTRUCTION — two tenants can never mint a colliding barcode and the
--    global unique never breaks on tenant #2. Keeping them global also
--    keeps the bench/MAR scan lookups (which may scan without a tenant
--    filter on the barcode itself) unambiguous. (W2 spec §329 hedge:
--    "verify they aren't tenant-prefixed-by-construction first" — they are.)
--  * pharmacy_orders.order_number — already tenant-scoped in migration 326
--    (uniq_pharmacy_orders_tenant_number).
--
-- Pattern + naming mirror migration 326 (uniq_<table>_tenant_<col>).

BEGIN;

DO $$
DECLARE
  rec       RECORD;
  new_name  text;
  actual_is_constraint boolean;
  clash_tenant text;
  clash_value text;
  clash_count bigint;
  collision_rows bigint;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- (table, column, old_global_object, is_constraint, is_partial)
      ('invoices',               'invoice_number',   'invoices_invoice_number_key',                 false, false),
      ('billing_invoices',       'invoice_number',   'billing_invoices_invoice_number_key',         false, true),
      ('appointments',           'visit_no',         'idx_appointments_visit_no_unique',            false, true),
      ('insurance_claims',       'claim_number',     'insurance_claims_claim_number_key',           false, false),
      ('tpa_claims',             'claim_number',     'tpa_claims_claim_number_key',                 false, false),
      ('pmjay_cases',            'case_number',      'pmjay_cases_case_number_key',                 true,  false),
      ('insurance_preauth',      'preauth_number',   'insurance_preauth_preauth_number_key',        false, false),
      ('referrals',              'referral_number',  'referrals_referral_number_key',               false, false),
      ('investigation_bookings', 'booking_number',   'investigation_bookings_booking_number_key',   false, true),
      ('clinical_orders',        'order_number',     'clinical_orders_order_number_key',            false, false),
      ('ward_indents',           'indent_number',    'ward_indents_indent_number_key',              false, false),
      ('incident_reports',       'report_number',    'incident_reports_report_number_key',          false, false),
      ('quality_incidents',      'incident_number',  'quality_incidents_incident_number_key',       false, false),
      ('staff_grievances',       'grievance_number', 'staff_grievances_grievance_number_key',       false, false),
      ('advance_deposits',       'receipt_number',   'advance_deposits_receipt_number_key',         false, false),
      ('attendant_passes',       'pass_number',      'attendant_passes_pass_number_key',            false, false),
      ('or_rooms',               'code',             'or_rooms_code_key',                           false, false),
      ('or_procedure_catalog',   'procedure_code',   'or_procedure_catalog_procedure_code_key',     false, false),
      ('clinical_order_sets',    'code',             'clinical_order_sets_code_key',                false, false),
      ('billing_service_master', 'code',             'billing_service_master_code_key',             false, false)
    ) AS v(tbl, col, old_obj, is_constraint, is_partial)
  LOOP
    -- Defensive: skip a table that doesn't exist in this DB.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = rec.tbl
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', rec.tbl;
      CONTINUE;
    END IF;

    -- Pre-check: a (tenant_id, col) collision would make the new unique
    -- fail with an opaque "could not create unique index". It CANNOT exist
    -- while the global unique still holds, but guard for re-application
    -- against data that is already multi-tenant.
    clash_tenant := NULL;
    clash_value := NULL;
    clash_count := NULL;
    EXECUTE format(
      'SELECT tenant_id::text, %1$I::text AS val, count(*) AS n FROM %2$I '
      'WHERE %1$I IS NOT NULL GROUP BY tenant_id, %1$I HAVING count(*) > 1 LIMIT 1',
      rec.col, rec.tbl
    ) INTO clash_tenant, clash_value, clash_count;
    GET DIAGNOSTICS collision_rows = ROW_COUNT;
    IF collision_rows > 0 THEN
      RAISE EXCEPTION
        'Cannot tenant-scope %.%: % rows already share (tenant_id=%, value=%); dedupe before applying migration 329',
        rec.tbl, rec.col, clash_count, clash_tenant, clash_value;
    END IF;

    -- Drop the global unique according to its actual catalog kind. A UNIQUE
    -- constraint owns its backing index, so DROP INDEX is rejected with 2BP01.
    -- QA and long-lived deployments do not necessarily share the same kind.
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint c
       WHERE c.conrelid = to_regclass(format('public.%I', rec.tbl))
         AND c.conname = rec.old_obj
         AND c.contype = 'u'
    ) INTO actual_is_constraint;

    IF rec.is_constraint IS DISTINCT FROM actual_is_constraint THEN
      RAISE NOTICE 'Catalog kind drift for %.%: expected constraint=%, actual constraint=%',
        rec.tbl, rec.col, rec.is_constraint, actual_is_constraint;
    END IF;

    IF actual_is_constraint THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', rec.tbl, rec.old_obj);
    ELSE
      EXECUTE format('DROP INDEX IF EXISTS public.%I', rec.old_obj);
    END IF;

    -- Re-add it tenant-scoped.
    new_name := format('uniq_%s_tenant_%s', rec.tbl, rec.col);
    IF rec.is_partial THEN
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, %I) WHERE %I IS NOT NULL',
        new_name, rec.tbl, rec.col, rec.col
      );
    ELSE
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, %I)',
        new_name, rec.tbl, rec.col
      );
    END IF;

    RAISE NOTICE 'Tenant-scoped %.% (dropped %, created %)', rec.tbl, rec.col, rec.old_obj, new_name;
  END LOOP;
END
$$;

COMMIT;
