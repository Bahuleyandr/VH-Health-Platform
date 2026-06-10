-- 296_infection_control_workbench.sql
--
-- Roadmap D5 (docs/EPIC_LEVEL_ROADMAP.md) — infection-control workbench.
-- The workbench itself adds NO tables (it aggregates infection_cases,
-- admissions ADT history, and micro_isolates/micro_sensitivities); this
-- migration closes the two gaps it exposed:
--
--   1. infection_cases carries patient PHI + tenant_id but was never in the
--      075/262/272 tenant_isolation set — no RLS policy at all. Add the
--      canonical policy (294 pattern: permissive when the GUC is unset/
--      empty/'bypass', so legacy paths and seeds keep working) + FORCE,
--      since prod (CNPG) connects as the table owner.
--
--   2. Contact tracing scans admissions by (ward, time-overlap). Give the
--      ADT overlap join a partial index instead of a seq scan.

BEGIN;

-- 1. Tenant isolation for infection_cases (262/272/294 pattern).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['infection_cases'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
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

-- 2. ADT ward-overlap scan support for contact tracing.
CREATE INDEX IF NOT EXISTS idx_admissions_ward_admitted
  ON admissions (ward, admitted_at)
  WHERE ward IS NOT NULL;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'INFECTION_CONTROL_WORKBENCH_APPLIED',
  'infection_cases',
  'infection_cases',
  jsonb_build_object(
    'migration', '296_infection_control_workbench.sql',
    'roadmap', 'docs/EPIC_LEVEL_ROADMAP.md#D5',
    'reason', 'Tenant RLS for infection_cases (was missing entirely) + ADT ward-overlap index for contact tracing.'
  ),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'INFECTION_CONTROL_WORKBENCH_APPLIED'
);

COMMIT;
