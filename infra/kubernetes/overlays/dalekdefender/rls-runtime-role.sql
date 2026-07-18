-- DalekDefender runtime RLS role.
--
-- The in-cluster bootstrap role `vhhealth` owns the database and is a
-- superuser in this single-node dev/test rig, so it bypasses Postgres row
-- level security. The backend keeps that connection for migrations, then
-- request-scoped tenant transactions SET LOCAL ROLE to `vhhealth_app`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vhhealth_app') THEN
    CREATE ROLE vhhealth_app NOLOGIN;
  END IF;
END $$;

ALTER ROLE vhhealth_app NOSUPERUSER NOBYPASSRLS;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE vhhealth TO vhhealth_app;
GRANT USAGE ON SCHEMA public TO vhhealth_app;
REVOKE CREATE ON SCHEMA public FROM vhhealth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vhhealth_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vhhealth_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vhhealth_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vhhealth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vhhealth_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO vhhealth_app;

-- ── Audit finding M17 (2026-06-10): non-superuser CONNECTION role ──────────
-- The backend previously CONNECTED as the superuser `vhhealth` full-time,
-- which bypasses RLS everywhere outside tenant transactions. Create a
-- non-superuser LOGIN role for the app's normal connection; keep the
-- superuser strictly for migrations.
--
-- OPERATOR steps on the rig (after running this file):
--   1. Set a strong password:
--        ALTER ROLE vhhealth_runtime PASSWORD '<openssl rand -base64 24>';
--   2. Point the vhhealth-backend Secret's DATABASE_URL at
--        postgresql://vhhealth_runtime:<pw>@vhhealth-postgres:5432/vhhealth
--   3. Run migrations via a one-off job/psql using the superuser DSN only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vhhealth_runtime') THEN
    CREATE ROLE vhhealth_runtime LOGIN;
  END IF;
END $$;

ALTER ROLE vhhealth_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT vhhealth_app TO vhhealth_runtime;
GRANT CONNECT ON DATABASE vhhealth TO vhhealth_runtime;
GRANT USAGE ON SCHEMA public TO vhhealth_runtime;
REVOKE CREATE ON SCHEMA public FROM vhhealth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vhhealth_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vhhealth_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vhhealth_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vhhealth_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vhhealth_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO vhhealth_runtime;
