-- 440_physio_assessments.sql
-- NL6-11: physiotherapy referral intake and structured assessment foundation.

CREATE TABLE IF NOT EXISTS physio_assessments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  encounter_id INTEGER,
  follow_up_plan_id INTEGER REFERENCES follow_up_plans(id) ON DELETE SET NULL,
  referral_id INTEGER REFERENCES referrals(id) ON DELETE SET NULL,
  care_plan_id INTEGER REFERENCES care_plans(id) ON DELETE SET NULL,
  assessment_kind VARCHAR(40) NOT NULL DEFAULT 'initial',
  mobility_status VARCHAR(40) NOT NULL DEFAULT 'not_assessed',
  pain_score INTEGER,
  rom_measures JSONB NOT NULL DEFAULT '[]'::jsonb,
  strength_measures JSONB NOT NULL DEFAULT '[]'::jsonb,
  functional_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  precautions TEXT,
  goals_text TEXT,
  baseline_outcome_score NUMERIC(5,2),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  assessed_by UUID,
  assessed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_physio_assessments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_physio_assessments_kind
    CHECK (assessment_kind IN ('initial', 'reassessment', 'discharge_readiness', 'functional_capacity', 'other')),
  CONSTRAINT chk_physio_assessments_mobility
    CHECK (mobility_status IN ('not_assessed', 'bed_bound', 'assisted_transfer', 'walker_supported', 'independent', 'restricted')),
  CONSTRAINT chk_physio_assessments_pain
    CHECK (pain_score IS NULL OR (pain_score >= 0 AND pain_score <= 10)),
  CONSTRAINT chk_physio_assessments_baseline_score
    CHECK (baseline_outcome_score IS NULL OR (baseline_outcome_score >= 0 AND baseline_outcome_score <= 100)),
  CONSTRAINT chk_physio_assessments_rom_array
    CHECK (jsonb_typeof(rom_measures) = 'array'),
  CONSTRAINT chk_physio_assessments_strength_array
    CHECK (jsonb_typeof(strength_measures) = 'array'),
  CONSTRAINT chk_physio_assessments_limitations_array
    CHECK (jsonb_typeof(functional_limitations) = 'array'),
  CONSTRAINT chk_physio_assessments_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_physio_assessments_patient
  ON physio_assessments (tenant_id, patient_uid, assessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_physio_assessments_follow_up
  ON physio_assessments (tenant_id, follow_up_plan_id)
  WHERE follow_up_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_physio_assessments_care_plan
  ON physio_assessments (tenant_id, care_plan_id)
  WHERE care_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_physio_assessments_assessed_by
  ON physio_assessments (tenant_id, assessed_by, assessed_at DESC)
  WHERE assessed_by IS NOT NULL;

ALTER TABLE physio_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE physio_assessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON physio_assessments;
CREATE POLICY tenant_isolation ON physio_assessments
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
