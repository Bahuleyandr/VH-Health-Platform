-- NL-14 P3: incubator/warmer (thermal environment) observations.
--
-- Point-in-time thermal environment rows for NICU care: incubator/radiant
-- warmer mode, set/air/skin temperatures, humidity. Incubator/warmer device
-- transport and credentials stay NL-7-owned (spec §7); device-sourced rows
-- land unverified until clinician review.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_thermal_environment_observations (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  care_environment VARCHAR(20) NOT NULL,
  control_mode VARCHAR(20),
  set_temperature_c NUMERIC(4, 1),
  air_temperature_c NUMERIC(4, 1),
  skin_temperature_c NUMERIC(4, 1),
  axillary_temperature_c NUMERIC(4, 1),
  humidity_pct NUMERIC(5, 1),

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

  CONSTRAINT nicu_thermal_environment_check
    CHECK (care_environment IN ('incubator', 'radiant_warmer', 'open_crib', 'kangaroo_care')),
  CONSTRAINT nicu_thermal_control_mode_check
    CHECK (control_mode IS NULL OR control_mode IN ('air_temperature', 'skin_servo', 'manual')),
  CONSTRAINT nicu_thermal_humidity_check
    CHECK (humidity_pct IS NULL OR (humidity_pct >= 0 AND humidity_pct <= 100)),
  CONSTRAINT nicu_thermal_source_check
    CHECK (source IN ('manual', 'device')),
  CONSTRAINT nicu_thermal_verification_check
    CHECK (verification_status IN ('not_applicable', 'unverified', 'verified')),
  CONSTRAINT fk_nicu_thermal_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_thermal_admission
  ON nicu_thermal_environment_observations (tenant_id, icu_admission_id, observed_at DESC);

ALTER TABLE nicu_thermal_environment_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_thermal_environment_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_thermal_environment_observations;
CREATE POLICY tenant_isolation ON nicu_thermal_environment_observations
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
