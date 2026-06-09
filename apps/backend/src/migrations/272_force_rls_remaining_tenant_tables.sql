-- 272_force_rls_remaining_tenant_tables.sql
--
-- Roadmap Pillar A / item A2 (docs/EPIC_LEVEL_ROADMAP.md).
--
-- Migration 237 applied FORCE ROW LEVEL SECURITY to the 8 PHI tables from
-- 236, and 238/239 forced their own batches — but the ORIGINAL migration-075
-- table set (users, clinical_ai_tenant_modules, clinical_ai_generations,
-- clinical_ai_prompts, clinical_ai_reviews, clinical_ai_approvals,
-- clinical_ai_context_snapshots, clinical_ai_safety_reviews,
-- clinical_ai_break_glass_sessions, clinical_ai_bed_forecasts,
-- clinical_ai_pharmacy_forecasts) was never revisited. `users` carries
-- patient PHI and prod (CNPG) connects as the table OWNER (`vhhealth`,
-- bootstrap.initdb.owner) — without FORCE, Postgres exempts owners and the
-- tenant_isolation policy is silently inert for every one of these tables
-- in production.
--
-- Rather than hardcode today's list, force EVERY public table that carries
-- a tenant_isolation policy and is not yet forced. This also future-proofs:
-- any later migration that adds a tenant_isolation policy but forgets FORCE
-- gets repaired by re-running the pattern (and the posture probe in
-- src/lib/prisma.js now alarms on unforced owned tables at boot).
--
-- Safety notes (same argument as 237):
--   * RLS USING/WITH CHECK applies to DML only, not DDL — migrations are
--     unaffected.
--   * The policy is permissive when the GUC is unset/empty/'bypass', so
--     legacy code paths and seed scripts keep working unchanged.
--   * Superuser / BYPASSRLS roles still bypass even under FORCE (Postgres
--     semantics) — that case is surfaced by logTenantRlsRolePosture() and
--     mitigated by the SET LOCAL ROLE runtime role (see migration 273).

BEGIN;

DO $$
DECLARE
  r RECORD;
  forced int := 0;
BEGIN
  FOR r IN
    SELECT p.schemaname, p.tablename
      FROM pg_policies p
      JOIN pg_class c      ON c.relname = p.tablename
      JOIN pg_namespace n  ON n.oid = c.relnamespace
                          AND n.nspname = p.schemaname
     WHERE p.schemaname = 'public'
       AND p.policyname = 'tenant_isolation'
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schemaname, r.tablename);
    forced := forced + 1;
    RAISE NOTICE 'FORCE ROW LEVEL SECURITY applied to %.%', r.schemaname, r.tablename;
  END LOOP;
  RAISE NOTICE 'migration 272: forced RLS on % table(s)', forced;
END
$$;

-- Audit trail (idempotent, mirrors 237's convention).
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_REMAINING_TABLES_FORCED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '272_force_rls_remaining_tenant_tables.sql',
    'strategy', 'dynamic — every public table with a tenant_isolation policy not yet FORCEd',
    'reason', 'Prod (CNPG) connects as the table owner; without FORCE the 075 table set (incl. users) silently bypasses RLS.',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#A2'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_REMAINING_TABLES_FORCED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);

COMMIT;
