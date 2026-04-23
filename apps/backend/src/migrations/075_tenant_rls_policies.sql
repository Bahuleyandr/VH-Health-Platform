-- 075_tenant_rls_policies.sql
-- Enable Row-Level Security on tenant-scoped tables with a policy that
-- enforces tenant isolation when `app.current_tenant_id` is set via
-- `db.queryAsTenant()`, and is permissive when the GUC is unset/empty.
-- This is a staged, opt-in defense-in-depth layer — legacy `db.query()`
-- calls that don't set the GUC continue to work unchanged.
--
-- When queryAsTenant sets `app.current_tenant_id` to the literal string
-- 'bypass', the policy allows all rows (SUPER_ADMIN cross-tenant reads).
--
-- NOTE: we intentionally do NOT use `ALTER TABLE ... FORCE ROW LEVEL
-- SECURITY`. The default (no FORCE) exempts the table owner, which is
-- what we want so future migrations running as the DB owner are not
-- themselves blocked by the policy.

-- Helper: cast the GUC to uuid only when it looks like one. Returns NULL for
-- unset/empty/'bypass' so the policy's OR chain never attempts to cast
-- `'bypass'::uuid` or `''::uuid` (Postgres may evaluate OR branches eagerly
-- in a policy plan, which would otherwise throw `invalid input syntax for
-- type uuid`).
CREATE OR REPLACE FUNCTION app_current_tenant_id_uuid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN current_setting('app.current_tenant_id', true) IS NULL THEN NULL
    WHEN current_setting('app.current_tenant_id', true) = '' THEN NULL
    WHEN current_setting('app.current_tenant_id', true) = 'bypass' THEN NULL
    ELSE current_setting('app.current_tenant_id', true)::uuid
  END
$$;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'users',
    'clinical_ai_tenant_modules',
    'clinical_ai_generations',
    'clinical_ai_prompts',
    'clinical_ai_reviews',
    'clinical_ai_approvals',
    'clinical_ai_context_snapshots',
    'clinical_ai_safety_reviews',
    'clinical_ai_break_glass_sessions',
    'clinical_ai_bed_forecasts',
    'clinical_ai_pharmacy_forecasts'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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

-- Record the rollout in audit_logs so the RLS migration is searchable
-- alongside the multi-tenant foundation. Idempotent per historical
-- convention used in 013_multi_tenant_foundation.sql.
INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_RLS_POLICIES_APPLIED',
  'tenants',
  '00000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'migration', '075_tenant_rls_policies.sql',
    'tables_enabled', 11,
    'policy', 'tenant_isolation',
    'guc', 'app.current_tenant_id'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_RLS_POLICIES_APPLIED'
    AND resource_id = '00000000-0000-4000-8000-000000000001'
);
