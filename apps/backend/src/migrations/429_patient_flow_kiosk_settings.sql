-- NL-8 P1: per-tenant, per-department kiosk check-in settings.
-- Follows the migration-351 pattern: tenant-scoped settings are explicit,
-- fail-closed, and never use the global feature_flags table.

CREATE TABLE IF NOT EXISTS patient_flow_kiosk_settings (
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_key           VARCHAR(120) NOT NULL,
  department_name          VARCHAR(160),
  self_service_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  supervised_mode_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  qr_otp_required          BOOLEAN NOT NULL DEFAULT TRUE,
  safe_profile_fields      TEXT[] NOT NULL DEFAULT ARRAY[
    'address',
    'email',
    'preferred_language',
    'emergency_contact'
  ]::text[],
  enabled_at               TIMESTAMPTZ(6),
  enabled_by               UUID,
  updated_by               UUID,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_flow_kiosk_settings_pk
    PRIMARY KEY (tenant_id, department_key),
  CONSTRAINT patient_flow_kiosk_settings_department_key_check
    CHECK (department_key = lower(department_key) AND department_key ~ '^[a-z0-9][a-z0-9_-]{0,119}$'),
  CONSTRAINT patient_flow_kiosk_settings_safe_fields_check
    CHECK (safe_profile_fields <@ ARRAY[
      'address',
      'email',
      'preferred_language',
      'emergency_contact'
    ]::text[])
);

CREATE INDEX IF NOT EXISTS idx_patient_flow_kiosk_settings_enabled
  ON patient_flow_kiosk_settings (tenant_id, self_service_enabled, supervised_mode_enabled);

ALTER TABLE patient_flow_kiosk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_flow_kiosk_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patient_flow_kiosk_settings;
CREATE POLICY tenant_isolation ON patient_flow_kiosk_settings
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
