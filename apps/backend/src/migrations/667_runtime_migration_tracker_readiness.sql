-- BOOT-001: API workers verify the exact migration tip with their normal
-- least-privilege login. Only the owner-credential PreSync Job applies DDL.
-- The tracker contains filenames/timestamps only and is safe for runtime
-- readiness; it does not expose clinical or tenant data.

DO $migration_tracker_grants$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE FORMAT('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
      EXECUTE FORMAT('GRANT SELECT ON TABLE public._migrations TO %I', runtime_role);
    END IF;
  END LOOP;
END
$migration_tracker_grants$;
