-- NL-14 P3: jaundice and phototherapy event timeline.
--
-- Bilirubin measurements and phototherapy lifecycle events on the NICU chart.
-- Treatment-threshold charts (AAP/NICE hour-specific nomograms) are NL-5
-- content-governed references: rows carry threshold provenance slots only;
-- no threshold math is hardcoded here or in the service.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_jaundice_phototherapy_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  event_kind VARCHAR(30) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  -- bilirubin_measurement fields
  bilirubin_total_mgdl NUMERIC(5, 2),
  bilirubin_direct_mgdl NUMERIC(5, 2),
  measurement_method VARCHAR(20),

  -- phototherapy lifecycle fields
  phototherapy_type VARCHAR(20),
  device_label VARCHAR(120),
  irradiance_uw_cm2_nm NUMERIC(6, 1),
  eye_protection_confirmed BOOLEAN,

  -- NL-5 content provenance slots (no hardcoded threshold charts)
  threshold_reference_source TEXT,
  threshold_reference_version VARCHAR(80),

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

  CONSTRAINT nicu_jaundice_event_kind_check
    CHECK (event_kind IN (
      'bilirubin_measurement', 'phototherapy_started',
      'phototherapy_adjusted', 'phototherapy_stopped'
    )),
  CONSTRAINT nicu_jaundice_measurement_method_check
    CHECK (measurement_method IS NULL OR measurement_method IN ('serum', 'transcutaneous')),
  CONSTRAINT nicu_jaundice_phototherapy_type_check
    CHECK (phototherapy_type IS NULL OR phototherapy_type IN (
      'single_surface', 'double_surface', 'intensive', 'fiberoptic'
    )),
  CONSTRAINT nicu_jaundice_bilirubin_positive_check
    CHECK (bilirubin_total_mgdl IS NULL OR bilirubin_total_mgdl >= 0),
  CONSTRAINT nicu_jaundice_source_check
    CHECK (source IN ('manual', 'device')),
  CONSTRAINT nicu_jaundice_verification_check
    CHECK (verification_status IN ('not_applicable', 'unverified', 'verified')),
  -- per-kind required fields
  CONSTRAINT nicu_jaundice_kind_payload_check
    CHECK (
      (event_kind = 'bilirubin_measurement'
        AND bilirubin_total_mgdl IS NOT NULL AND measurement_method IS NOT NULL)
      OR (event_kind IN ('phototherapy_started', 'phototherapy_adjusted')
        AND phototherapy_type IS NOT NULL)
      OR event_kind = 'phototherapy_stopped'
    ),
  CONSTRAINT fk_nicu_jaundice_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_jaundice_admission
  ON nicu_jaundice_phototherapy_events (tenant_id, icu_admission_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_nicu_jaundice_kind
  ON nicu_jaundice_phototherapy_events (tenant_id, icu_admission_id, event_kind, occurred_at DESC);

ALTER TABLE nicu_jaundice_phototherapy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_jaundice_phototherapy_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_jaundice_phototherapy_events;
CREATE POLICY tenant_isolation ON nicu_jaundice_phototherapy_events
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
