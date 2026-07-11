-- NL-14 P3: neonatal respiratory support observations + apnea/brady/desat events.
--
-- Respiratory support rows EXTEND the P1 ventilation substrate: invasive
-- episodes stay in icu_ventilation_episodes (mig 496); these rows chart the
-- neonatal oxygen/CPAP/ventilator mode picture at observation granularity and
-- may link back to the governing P1 episode. Cardiorespiratory events capture
-- apnea/bradycardia/desaturation with interventions; device-derived events
-- (NL-7 monitors) land unverified until clinician review.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_respiratory_support_observations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  ventilation_episode_id BIGINT REFERENCES icu_ventilation_episodes(id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  support_mode VARCHAR(30) NOT NULL,
  fio2_pct NUMERIC(5, 1),
  flow_lpm NUMERIC(5, 1),
  peep_cm_h2o NUMERIC(4, 1),
  pip_cm_h2o NUMERIC(4, 1),
  mean_airway_pressure_cm_h2o NUMERIC(4, 1),
  set_rate_per_min INTEGER,

  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE SET NULL,
  sample_observation_id INTEGER REFERENCES device_vital_sample_observations(id) ON DELETE SET NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable',
  verified_by UUID,
  verified_at TIMESTAMPTZ(6),

  recorded_by UUID,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT nicu_resp_support_mode_check
    CHECK (support_mode IN (
      'room_air', 'low_flow_o2', 'high_flow_o2', 'cpap', 'nippv',
      'bipap_niv', 'conventional_ventilation', 'hfov', 'other'
    )),
  CONSTRAINT nicu_resp_support_fio2_check
    CHECK (fio2_pct IS NULL OR (fio2_pct >= 21 AND fio2_pct <= 100)),
  CONSTRAINT nicu_resp_support_source_check
    CHECK (source IN ('manual', 'device')),
  CONSTRAINT nicu_resp_support_verification_check
    CHECK (verification_status IN ('not_applicable', 'unverified', 'verified')),
  CONSTRAINT fk_nicu_resp_support_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_resp_support_admission
  ON nicu_respiratory_support_observations (tenant_id, icu_admission_id, observed_at DESC);

ALTER TABLE nicu_respiratory_support_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_respiratory_support_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_respiratory_support_observations;
CREATE POLICY tenant_isolation ON nicu_respiratory_support_observations
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

CREATE TABLE IF NOT EXISTS nicu_cardiorespiratory_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  event_kind VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  duration_seconds INTEGER,
  lowest_heart_rate INTEGER,
  lowest_spo2_pct INTEGER,
  self_resolved BOOLEAN,
  intervention VARCHAR(30),
  intervention_detail TEXT,

  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  device_registry_id INTEGER REFERENCES device_registry(id) ON DELETE SET NULL,
  sample_observation_id INTEGER REFERENCES device_vital_sample_observations(id) ON DELETE SET NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable',
  verified_by UUID,
  verified_at TIMESTAMPTZ(6),

  recorded_by UUID,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT nicu_cardioresp_event_kind_check
    CHECK (event_kind IN ('apnea', 'bradycardia', 'desaturation', 'combined')),
  CONSTRAINT nicu_cardioresp_intervention_check
    CHECK (intervention IS NULL OR intervention IN (
      'none', 'tactile_stimulation', 'repositioning', 'suction',
      'increased_o2', 'bag_mask', 'other'
    )),
  CONSTRAINT nicu_cardioresp_duration_check
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT nicu_cardioresp_spo2_check
    CHECK (lowest_spo2_pct IS NULL OR (lowest_spo2_pct >= 0 AND lowest_spo2_pct <= 100)),
  CONSTRAINT nicu_cardioresp_source_check
    CHECK (source IN ('manual', 'device')),
  CONSTRAINT nicu_cardioresp_verification_check
    CHECK (verification_status IN ('not_applicable', 'unverified', 'verified')),
  CONSTRAINT fk_nicu_cardioresp_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_cardioresp_admission
  ON nicu_cardiorespiratory_events (tenant_id, icu_admission_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_nicu_cardioresp_unverified
  ON nicu_cardiorespiratory_events (tenant_id, icu_admission_id)
  WHERE verification_status = 'unverified';

ALTER TABLE nicu_cardiorespiratory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_cardiorespiratory_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_cardiorespiratory_events;
CREATE POLICY tenant_isolation ON nicu_cardiorespiratory_events
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
