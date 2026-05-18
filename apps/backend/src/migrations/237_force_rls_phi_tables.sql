-- 237_force_rls_phi_tables.sql
--
-- Phase-2 prerequisite: force the tenant_isolation policy from migration
-- 236 to apply even when the connecting role owns the table. Without
-- FORCE, the default Postgres behaviour exempts table owners from RLS —
-- and prod (plus CI) connect as a role that owns these tables, so the
-- policy would silently bypass.
--
-- The original migration 075 comment ("we intentionally do NOT use
-- FORCE so future migrations running as the DB owner are not themselves
-- blocked by the policy") was being overly cautious: RLS USING/WITH
-- CHECK applies only to DML (INSERT/UPDATE/DELETE/SELECT), not DDL.
-- Migrations doing DDL are unaffected. The only DML migrations might
-- need is seeding tenant rows during initial setup — those land BEFORE
-- this migration runs, and any future PHI-row seed should wrap in
-- `SELECT set_config('app.current_tenant_id', 'bypass', true)` first.
--
-- Scope: the same 8 PHI tables migration 236 enabled RLS on.
--
-- This makes the substrate at src/lib/prisma.js (Phase-2 PR) actually
-- enforce isolation in CI and prod, not just in the local QA cluster
-- where the connecting role happens to be a non-owner.

BEGIN;

DO $$
DECLARE
  t text;
  phi_tables text[] := ARRAY[
    'appointments',
    'admissions',
    'clinical_notes',
    'prescriptions',
    'e_prescriptions',
    'investigations',
    'vitals_chart',
    'emergency_visits'
  ];
BEGIN
  FOREACH t IN ARRAY phi_tables
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Skipping FORCE RLS on %: table does not exist', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Audit trail.
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_PHI_FORCED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '237_force_rls_phi_tables.sql',
    'tables_forced', jsonb_build_array(
      'appointments', 'admissions', 'clinical_notes', 'prescriptions',
      'e_prescriptions', 'investigations', 'vitals_chart', 'emergency_visits'
    ),
    'reason', 'Prod connects as table owner; without FORCE the policy bypasses.',
    'gap_doc', 'docs/GAP_ANALYSIS_TENANT_RLS.md'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_PHI_FORCED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
