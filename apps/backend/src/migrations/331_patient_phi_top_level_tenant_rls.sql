-- 331_patient_phi_top_level_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH (patient PHI).
--
-- Three top-level patient PHI tables were keyed only by uid/phone with NO
-- tenant_id / RLS — cross-tenant readable/writable:
--   * consultations   — teleconsult/OP consultation records
--   * health_records   — uploaded patient health documents
--   * sos_alerts        — emergency SOS events (location + patient)
-- Pattern A: tenant_id + ENABLE/FORCE RLS + canonical tenant_isolation
-- policy + GUC-reading DEFAULT.
--
-- BACKFILL (verified against live QA schema, mig tip 330): each table has
-- a nullable uid (uuid -> users.uid) and a NOT NULL phone (varchar). There
-- is no FK to users (these are phone-keyed, loosely coupled — the house
-- pattern). users.phone is still globally unique at this migration (333
-- makes it per-tenant later), so the phone fallback is unambiguous now.
-- Backfill order: uid join, then phone fallback, then the default tenant
-- for any orphan. Safe on existing single-tenant data (all default tenant).
--
-- Mirrors migration 239 (multi-table Pattern A) + 328 (GUC default).

BEGIN;

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY['consultations','health_records','sos_alerts'];
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);

    -- Backfill via uid (exact uuid match) where present.
    EXECUTE format(
      'UPDATE %I x SET tenant_id = COALESCE(u.tenant_id, ''00000000-0000-4000-8000-000000000001''::uuid) '
      'FROM users u WHERE x.tenant_id IS NULL AND x.uid IS NOT NULL AND u.uid = x.uid', t
    );
    -- Phone fallback (NOT NULL; users.phone globally unique at this migration).
    EXECUTE format(
      'UPDATE %I x SET tenant_id = COALESCE(u.tenant_id, ''00000000-0000-4000-8000-000000000001''::uuid) '
      'FROM users u WHERE x.tenant_id IS NULL AND u.phone = x.phone', t
    );
    -- Orphans -> default tenant.
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

    -- RLS.
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

COMMIT;
