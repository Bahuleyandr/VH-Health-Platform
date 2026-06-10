-- 295_analytics_publication.sql
--
-- Roadmap Pillar F / item F1 (docs/EPIC_LEVEL_ROADMAP.md) — analytics
-- warehouse foundations: the logical-replication PUBLICATION feeding the
-- separate warehouse Postgres (infra/kubernetes/optional/analytics-warehouse,
-- a second CNPG cluster following the B4 PACS opt-in pattern).
--
--   * Curated table list — deliberately NOT "FOR ALL TABLES". Only what the
--     dbt star schemas (infra/kubernetes/optional/analytics-warehouse/dbt)
--     read. Keeps the warehouse PHI surface
--     reviewable, keeps credential/audit/AI tables out wholesale, and means
--     a future PK-less table can never silently wedge replication.
--   * users is published with a COLUMN LIST (PG15+): identity, demographics
--     and tenancy only. name/phone/address (incl. *_encrypted columns),
--     encrypted_password, e2e keys, ABHA identifiers, device tokens, and
--     guardian contact details never leave the OLTP cluster.
--   * Replica-identity guard: every published table must have a PRIMARY KEY
--     — UPDATE/DELETE decoding fails without one, and the failure mode
--     (wedged subscription + unbounded WAL retention on the primary via the
--     replication slot) is the worst kind of 3 AM surprise. This migration
--     fails loudly instead.
--   * Grants: SELECT on the published set to vh_warehouse_repl WHEN the role
--     exists (created on the prod cluster by the optional overlay's
--     publisher-setup job; absent on dev/QA DBs where this migration must
--     still apply cleanly). The publisher-setup job re-applies grants from
--     pg_publication_tables, so role-after-migration ordering also works.
--
-- Adding a table later: new migration with ALTER PUBLICATION vh_analytics_pub
-- ADD TABLE <t>; (plus conditional grant), then run the warehouse
-- refresh-publication job (ALTER SUBSCRIPTION ... REFRESH PUBLICATION).
-- Full runbook: docs/ANALYTICS_WAREHOUSE.md.
--
-- Payroll/cost tables are deliberately excluded from v1 — salary data in a
-- dashboards database needs an explicit owner sign-off first (see the
-- "Department P&L" note in docs/ANALYTICS_WAREHOUSE.md).

BEGIN;

DO $$
DECLARE
  t text;
  pub_tables text[] := ARRAY[
    'admissions', 'appointments', 'emergency_visits', 'icu_admissions',
    'ot_schedules', 'bed_transfers', 'beds', 'wards', 'departments',
    'doctors', 'billing_invoices', 'billing_invoice_items',
    'billing_payments', 'payers', 'tpas', 'tpa_claims', 'insurance_claims',
    'insurance_policies', 'clinical_orders', 'pharmacy_orders',
    'investigations', 'users'
  ];
BEGIN
  -- 1. Replica-identity guard (PK required on every member).
  FOREACH t IN ARRAY pub_tables LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'analytics publication: table % does not exist', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = t::regclass AND i.indisprimary
    ) THEN
      RAISE EXCEPTION 'analytics publication: table % has no primary key (replica identity needed for UPDATE/DELETE decoding)', t;
    END IF;
  END LOOP;

  -- 2. The publication itself (idempotent). users carries a column list —
  --    the list MUST include the replica identity (id) and stays in lockstep
  --    with the allow-list asserted in analytics-warehouse.deep.test.js.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'vh_analytics_pub') THEN
    EXECUTE 'CREATE PUBLICATION vh_analytics_pub FOR TABLE
        admissions, appointments, emergency_visits, icu_admissions,
        ot_schedules, bed_transfers, beds, wards, departments, doctors,
        billing_invoices, billing_invoice_items, billing_payments,
        payers, tpas, tpa_claims, insurance_claims, insurance_policies,
        clinical_orders, pharmacy_orders, investigations,
        users (id, uid, role, gender, birthday, is_active, is_minor,
               registered_at, tenant_id)
      WITH (publish = ''insert, update, delete, truncate'')';
  END IF;

  -- 3. Publisher-side read grants for the replication role, when present.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vh_warehouse_repl') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO vh_warehouse_repl';
    FOREACH t IN ARRAY pub_tables LOOP
      EXECUTE format('GRANT SELECT ON %I TO vh_warehouse_repl', t);
    END LOOP;
  END IF;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ANALYTICS_PUBLICATION_APPLIED',
  'vh_analytics_pub',
  'vh_analytics_pub',
  jsonb_build_object(
    'migration', '295_analytics_publication.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#F1',
    'reason', 'Curated logical-replication publication for the analytics warehouse (22 tables; users column-listed to exclude credentials/contact PHI).'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ANALYTICS_PUBLICATION_APPLIED'
    AND resource = 'vh_analytics_pub'
);

COMMIT;
