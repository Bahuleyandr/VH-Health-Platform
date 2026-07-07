-- 382_content_studio_settings.sql
--
-- NL-5 P3: per-tenant flag for the order-set/pathway content studio.
--
-- The studio is inert by default. When disabled, createOrderSet keeps the
-- historical approved behavior. When enabled, authoring creates drafts.

BEGIN;

CREATE TABLE IF NOT EXISTS content_studio_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at          TIMESTAMPTZ(6),
  enabled_by          UUID,
  acceptance_snapshot JSONB,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE content_studio_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_studio_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content_studio_settings;
CREATE POLICY tenant_isolation ON content_studio_settings
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
  );

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'CONTENT_STUDIO_SETTINGS_APPLIED',
  'content_studio_settings',
  'content_studio_settings',
  jsonb_build_object(
    'migration', '382_content_studio_settings.sql',
    'program', 'NL-5 P3',
    'reason', 'Add inert per-tenant order-set content studio flag.',
    'default_enabled', false,
    'rls_pattern', 'Pattern A copied from migration 351'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'CONTENT_STUDIO_SETTINGS_APPLIED'
    AND resource = 'content_studio_settings'
);

COMMIT;
