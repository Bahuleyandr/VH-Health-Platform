-- NL-7 P1: device ingest idempotency, alarm policy, and suppression counters.

ALTER TABLE device_registry
  ADD COLUMN IF NOT EXISTS charting_interval_minutes INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS critical_suppression_window_minutes INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS warning_suppression_window_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS artifact_filter_required INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS artifact_filter_window INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS expected_interval_seconds INTEGER NOT NULL DEFAULT 60;

ALTER TABLE device_registry
  DROP CONSTRAINT IF EXISTS device_registry_charting_interval_check,
  ADD CONSTRAINT device_registry_charting_interval_check CHECK (charting_interval_minutes BETWEEN 1 AND 120),
  DROP CONSTRAINT IF EXISTS device_registry_suppression_windows_check,
  ADD CONSTRAINT device_registry_suppression_windows_check CHECK (
    critical_suppression_window_minutes BETWEEN 1 AND 120
    AND warning_suppression_window_minutes BETWEEN 1 AND 240
  ),
  DROP CONSTRAINT IF EXISTS device_registry_artifact_filter_check,
  ADD CONSTRAINT device_registry_artifact_filter_check CHECK (
    artifact_filter_required BETWEEN 1 AND artifact_filter_window
    AND artifact_filter_window BETWEEN 1 AND 12
  ),
  DROP CONSTRAINT IF EXISTS device_registry_expected_interval_check,
  ADD CONSTRAINT device_registry_expected_interval_check CHECK (expected_interval_seconds BETWEEN 15 AND 86400);

CREATE TABLE IF NOT EXISTS device_vitals_control_ids (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  device_registry_id INTEGER NOT NULL REFERENCES device_registry(id) ON DELETE CASCADE,
  control_id VARCHAR(120) NOT NULL,
  interface_message_id INTEGER REFERENCES lab_interface_messages(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ(6) NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_vitals_control_id
  ON device_vitals_control_ids (tenant_id, device_registry_id, control_id);

CREATE INDEX IF NOT EXISTS idx_device_vitals_control_ids_expires
  ON device_vitals_control_ids (expires_at);

CREATE TABLE IF NOT EXISTS device_vital_sample_observations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  device_registry_id INTEGER NOT NULL REFERENCES device_registry(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  channel VARCHAR(80) NOT NULL DEFAULT '',
  vital_name VARCHAR(60) NOT NULL,
  severity VARCHAR(20),
  breached BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_vital_observations_recent
  ON device_vital_sample_observations (tenant_id, device_registry_id, channel, patient_uid, vital_name, observed_at DESC);

CREATE TABLE IF NOT EXISTS device_vital_suppression_counters (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE CASCADE,
  reason VARCHAR(60) NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, device_registry_id, reason)
);

ALTER TABLE device_vitals_control_ids
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

ALTER TABLE device_vital_sample_observations
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

ALTER TABLE device_vital_suppression_counters
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_device_repeat_suppression
  ON clinical_alerts (tenant_id, patient_id, vital_name, severity, created_at DESC)
  WHERE COALESCE(acknowledged, false) = false AND acknowledged_at IS NULL;

ALTER TABLE device_vitals_control_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_vital_sample_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_vital_suppression_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_vitals_control_ids FORCE ROW LEVEL SECURITY;
ALTER TABLE device_vital_sample_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE device_vital_suppression_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_vitals_control_ids_tenant_isolation ON device_vitals_control_ids;
DROP POLICY IF EXISTS tenant_isolation ON device_vitals_control_ids;
CREATE POLICY tenant_isolation ON device_vitals_control_ids
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

DROP POLICY IF EXISTS device_vital_sample_obs_tenant_isolation ON device_vital_sample_observations;
DROP POLICY IF EXISTS tenant_isolation ON device_vital_sample_observations;
CREATE POLICY tenant_isolation ON device_vital_sample_observations
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

DROP POLICY IF EXISTS device_vital_suppression_tenant_isolation ON device_vital_suppression_counters;
DROP POLICY IF EXISTS tenant_isolation ON device_vital_suppression_counters;
CREATE POLICY tenant_isolation ON device_vital_suppression_counters
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
