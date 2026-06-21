-- 335_audit_activity_logs_tenant_rls.sql
--
-- W2 (multi-tenancy program) — schema completeness, HIGH (decision §8.4:
-- audit/activity logs are tenant-scoped). Nine audit/activity-log tables had
-- NO tenant_id / RLS — cross-tenant readable:
--   admin_activity_logs, audit_log, audit_logs, file_access_logs,
--   file_metadata, hr_activity_logs, medical_activity_logs,
--   notification_outbox, pharmacy_activity_logs
-- Pattern A: tenant_id + ENABLE/FORCE RLS + canonical tenant_isolation policy
-- + GUC-reading DEFAULT. SUPER_ADMIN cross-tenant audit reads keep working
-- via the policy's `bypass` branch (the audited acting-tenant path).
--
-- BACKFILL = DEFAULT TENANT for all rows. Every existing log row predates
-- multi-tenancy (single-tenant production), so the tenant it was written under
-- IS the default tenant. A per-row join to the actor/subject would resolve to
-- the same default tenant anyway, and these tables carry heterogeneous linkage
-- columns of mixed type (uid/actor_uid/subject_uid/staff_uid/staff_id/user_id/
-- recipient_phone) — joining them invites the integer=uuid class of error for
-- zero correctness gain. New rows get their tenant from the GUC-reading DEFAULT.
--
-- APPEND-ONLY SAFETY. audit_log + audit_logs carry the migration-324
-- BEFORE UPDATE OR DELETE append-only guard. The backfill is an UPDATE, so it
-- would be blocked. Per migration 324's documented contract we set
-- `app.audit_bypass = 'on'` transaction-locally — the authorized-maintenance
-- escape hatch — so the one-time backfill is permitted regardless of whether
-- the migration runs as superuser (CI) or the sealed app role (runtime). DDL
-- (ADD COLUMN / SET NOT NULL / ADD CONSTRAINT) does not fire the row trigger;
-- only the backfill UPDATE does. INSERT (the audit append path) is never
-- touched. SET LOCAL is cleared at COMMIT — no leak across pooled connections.
--
-- Mirrors migration 239 (multi-table Pattern A) + 328 (GUC default).

BEGIN;

-- Authorize the one-time backfill UPDATE on the append-only audit tables.
SET LOCAL app.audit_bypass = 'on';

DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'admin_activity_logs','audit_log','audit_logs','file_access_logs','file_metadata',
    'hr_activity_logs','medical_activity_logs','notification_outbox','pharmacy_activity_logs'
  ];
  default_expr text := $def$COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, '00000000-0000-4000-8000-000000000001'::uuid)$def$;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid', t);
    -- Backfill historical rows to the default tenant (single-tenant era).
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

    RAISE NOTICE 'Tenant-isolated audit/activity table % (append-only preserved)', t;
  END LOOP;
END
$$;

COMMIT;
