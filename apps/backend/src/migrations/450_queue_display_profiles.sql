-- NL8-P2: PHI-free queue-display settings and profiles.
-- Public display payloads are token-only: no names, initials, phones,
-- patient identifiers, reasons, diagnoses, or notes are stored here.
-- tenant_id has NO GUC default; service writers must supply it explicitly.

BEGIN;

CREATE TABLE IF NOT EXISTS queue_display_settings (
  tenant_id                  UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                    BOOLEAN NOT NULL DEFAULT FALSE,
  poll_interval_seconds      INTEGER NOT NULL DEFAULT 15
    CHECK (poll_interval_seconds BETWEEN 5 AND 120),
  max_items                  INTEGER NOT NULL DEFAULT 12
    CHECK (max_items BETWEEN 1 AND 50),
  eta_buckets_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  default_language_code      VARCHAR(16) NOT NULL DEFAULT 'en',
  default_accessibility_size VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (default_accessibility_size IN ('standard', 'large', 'extra_large')),
  enabled_at                 TIMESTAMPTZ(6),
  enabled_by                 UUID,
  acceptance_snapshot        JSONB,
  updated_by                 UUID,
  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE queue_display_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_display_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON queue_display_settings;
CREATE POLICY tenant_isolation ON queue_display_settings
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

CREATE TABLE IF NOT EXISTS queue_display_profiles (
  id                          BIGSERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_key                 VARCHAR(80) NOT NULL,
  display_name                VARCHAR(160) NOT NULL,
  location_label              VARCHAR(160),
  facility_id                 INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  department_id               INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  doctor_id                   INTEGER,
  queue_kind                  VARCHAR(40)
    CHECK (queue_kind IN ('op', 'walk_in', 'department', 'doctor', 'emergency', 'lab', 'imaging', 'other')),
  queue_label_override        VARCHAR(255),
  counter_label               VARCHAR(120),
  display_mode                VARCHAR(40) NOT NULL DEFAULT 'token_board'
    CHECK (display_mode IN ('token_board', 'counter_board', 'department_board')),
  language_code               VARCHAR(16) NOT NULL DEFAULT 'en',
  accessibility_size          VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (accessibility_size IN ('standard', 'large', 'extra_large')),
  contrast_mode               VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (contrast_mode IN ('standard', 'high')),
  motion_mode                 VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (motion_mode IN ('standard', 'reduced')),
  audio_announcements_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  masked_name_policy          VARCHAR(40) NOT NULL DEFAULT 'token_only'
    CHECK (masked_name_policy = 'token_only'),
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by                  UUID,
  updated_by                  UUID,
  created_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_queue_display_profiles_key
  ON queue_display_profiles (tenant_id, profile_key);
CREATE INDEX IF NOT EXISTS idx_queue_display_profiles_active
  ON queue_display_profiles (tenant_id, is_active, display_name);
CREATE INDEX IF NOT EXISTS idx_queue_display_profiles_department
  ON queue_display_profiles (tenant_id, department_id, is_active)
  WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_queue_display_profiles_doctor
  ON queue_display_profiles (tenant_id, doctor_id, is_active)
  WHERE doctor_id IS NOT NULL;

ALTER TABLE queue_display_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_display_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON queue_display_profiles;
CREATE POLICY tenant_isolation ON queue_display_profiles
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
