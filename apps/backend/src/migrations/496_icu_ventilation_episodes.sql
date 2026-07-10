-- NL-14 P1: durable ICU ventilation episodes.
--
-- Ventilation is no longer only a value in an hourly flowsheet cell. Episodes
-- capture start/stop lifecycle, settings, clinician responsibility, and MAR
-- references without creating a parallel medication administration lane.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_ventilation_episodes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  mode VARCHAR(40) NOT NULL,
  oxygen_device VARCHAR(80),
  airway_type VARCHAR(40),
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ(6),
  start_reason TEXT,
  stop_reason TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  responsible_clinician_uid UUID,
  responsible_clinician_name VARCHAR(160),
  started_by UUID,
  stopped_by UUID,
  linked_mar_administration_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_ventilation_mode_not_blank CHECK (length(trim(mode)) > 0),
  CONSTRAINT icu_ventilation_time_check CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CONSTRAINT icu_ventilation_airway_check
    CHECK (airway_type IS NULL OR airway_type IN ('ett', 'tracheostomy', 'non_invasive', 'oxygen_device', 'none')),
  CONSTRAINT fk_icu_ventilation_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_icu_ventilation_episode_admission
  ON icu_ventilation_episodes (tenant_id, icu_admission_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_icu_ventilation_episode_active
  ON icu_ventilation_episodes (tenant_id, icu_admission_id)
  WHERE stopped_at IS NULL;

ALTER TABLE icu_ventilation_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_ventilation_episodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_ventilation_episodes;
CREATE POLICY tenant_isolation ON icu_ventilation_episodes
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
