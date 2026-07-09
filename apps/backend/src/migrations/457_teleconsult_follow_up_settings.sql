-- NL9-P3: tenant-scoped teleconsult follow-up trigger settings.
--
-- The tenant flag is disabled by default, but the trigger bundle itself ships
-- with the spec defaults enabled so a tenant opt-in activates the known safe
-- completion facts without a second config migration.

BEGIN;

CREATE TABLE IF NOT EXISTS teleconsult_follow_up_settings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMPTZ,
  enabled_by UUID,
  acceptance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_type VARCHAR(80) NOT NULL DEFAULT 'teleconsult_followup',
  patient_route VARCHAR(160) NOT NULL DEFAULT '/appointments',
  secure_message_route VARCHAR(160) NOT NULL DEFAULT '/portal/messages',
  staff_task_role VARCHAR(80) NOT NULL DEFAULT 'DOCTOR',
  trigger_defaults JSONB NOT NULL DEFAULT '{
    "clinician_follow_up_due_date": {"enabled": true, "offset_days": 0},
    "investigation_ordered": {"enabled": true, "offset_days": 3},
    "prescription_created": {"enabled": true, "offset_days": 2},
    "secure_message_fallback": {"enabled": true, "offset_days": 1},
    "teleconsult_completed": {"enabled": true, "offset_days": 7}
  }'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT teleconsult_follow_up_settings_snapshot_object
    CHECK (jsonb_typeof(acceptance_snapshot) = 'object'),
  CONSTRAINT teleconsult_follow_up_settings_trigger_defaults_object
    CHECK (jsonb_typeof(trigger_defaults) = 'object'),
  CONSTRAINT teleconsult_follow_up_settings_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT teleconsult_follow_up_settings_routes_are_safe
    CHECK (patient_route LIKE '/%' AND secure_message_route LIKE '/%'),
  UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_teleconsult_follow_up_settings_enabled
  ON teleconsult_follow_up_settings (tenant_id, enabled);

ALTER TABLE teleconsult_follow_up_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE teleconsult_follow_up_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON teleconsult_follow_up_settings;
CREATE POLICY tenant_isolation ON teleconsult_follow_up_settings
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

COMMIT;
