-- NL-14 P3: NICU/PICU feed and fluid chart.
--
-- Typed feed/fluid rows over the P1 ICU chart substrate (icu_admissions with
-- unit_code PICU/NICU) — not a parallel silo. Weight rows anchor the
-- weight-adjusted balance math (mL/kg); glucose rows keep point-of-care sugar
-- checks on the same dense neonatal chart. Device-sourced rows (syringe/
-- infusion pumps via NL-7) land unverified until clinician review.

BEGIN;

CREATE TABLE IF NOT EXISTS nicu_feed_fluid_entries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  entry_kind VARCHAR(20) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  -- feed / fluid_intake fields
  feed_type VARCHAR(30),
  feed_route VARCHAR(20),
  volume_ml NUMERIC(8, 2),
  duration_minutes INTEGER,
  fortifier_added BOOLEAN NOT NULL DEFAULT FALSE,
  fortifier_detail TEXT,

  -- fluid_output fields
  output_kind VARCHAR(20),
  output_volume_ml NUMERIC(8, 2),
  diaper_weight_based BOOLEAN,

  -- glucose fields
  glucose_mgdl NUMERIC(6, 1),
  glucose_source VARCHAR(20),

  -- weight fields (weight-of-day anchors for mL/kg balance)
  weight_grams INTEGER,

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

  CONSTRAINT nicu_feed_fluid_entry_kind_check
    CHECK (entry_kind IN ('feed', 'fluid_intake', 'fluid_output', 'glucose', 'weight')),
  CONSTRAINT nicu_feed_fluid_feed_type_check
    CHECK (feed_type IS NULL OR feed_type IN (
      'breast_milk', 'expressed_breast_milk', 'donor_milk', 'formula',
      'fortified_feed', 'tpn', 'iv_fluid', 'medication_volume', 'other'
    )),
  CONSTRAINT nicu_feed_fluid_feed_route_check
    CHECK (feed_route IS NULL OR feed_route IN (
      'oral', 'breast', 'ng_tube', 'og_tube', 'gastrostomy',
      'iv_peripheral', 'iv_central', 'umbilical'
    )),
  CONSTRAINT nicu_feed_fluid_output_kind_check
    CHECK (output_kind IS NULL OR output_kind IN (
      'urine', 'stool', 'emesis', 'gastric_aspirate', 'drain', 'other'
    )),
  CONSTRAINT nicu_feed_fluid_glucose_source_check
    CHECK (glucose_source IS NULL OR glucose_source IN (
      'heel_prick', 'venous', 'arterial', 'sensor'
    )),
  CONSTRAINT nicu_feed_fluid_source_check
    CHECK (source IN ('manual', 'device')),
  CONSTRAINT nicu_feed_fluid_verification_check
    CHECK (verification_status IN ('not_applicable', 'unverified', 'verified')),
  CONSTRAINT nicu_feed_fluid_volume_positive_check
    CHECK (volume_ml IS NULL OR volume_ml >= 0),
  CONSTRAINT nicu_feed_fluid_output_volume_positive_check
    CHECK (output_volume_ml IS NULL OR output_volume_ml >= 0),
  CONSTRAINT nicu_feed_fluid_weight_positive_check
    CHECK (weight_grams IS NULL OR weight_grams > 0),
  -- per-kind required fields stay fail-closed at the schema layer
  CONSTRAINT nicu_feed_fluid_kind_payload_check
    CHECK (
      (entry_kind = 'feed' AND feed_type IS NOT NULL AND volume_ml IS NOT NULL)
      OR (entry_kind = 'fluid_intake' AND volume_ml IS NOT NULL)
      OR (entry_kind = 'fluid_output' AND output_kind IS NOT NULL AND output_volume_ml IS NOT NULL)
      OR (entry_kind = 'glucose' AND glucose_mgdl IS NOT NULL)
      OR (entry_kind = 'weight' AND weight_grams IS NOT NULL)
    ),
  CONSTRAINT fk_nicu_feed_fluid_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nicu_feed_fluid_admission
  ON nicu_feed_fluid_entries (tenant_id, icu_admission_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_nicu_feed_fluid_kind
  ON nicu_feed_fluid_entries (tenant_id, icu_admission_id, entry_kind, recorded_at DESC);

ALTER TABLE nicu_feed_fluid_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE nicu_feed_fluid_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nicu_feed_fluid_entries;
CREATE POLICY tenant_isolation ON nicu_feed_fluid_entries
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
