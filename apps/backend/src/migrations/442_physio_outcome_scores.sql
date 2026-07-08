-- 442_physio_outcome_scores.sql
-- NL6-11: longitudinal physiotherapy outcome scoring.

CREATE TABLE IF NOT EXISTS physio_outcome_scores (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  care_plan_id INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  assessment_id BIGINT REFERENCES physio_assessments(id) ON DELETE SET NULL,
  session_id BIGINT REFERENCES physio_sessions(id) ON DELETE SET NULL,
  score_kind VARCHAR(40) NOT NULL DEFAULT 'functional',
  score_label VARCHAR(160) NOT NULL,
  score_value NUMERIC(8,2) NOT NULL,
  score_unit VARCHAR(40) NOT NULL DEFAULT 'score',
  scored_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  recorded_by UUID,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_physio_outcome_scores_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_physio_outcome_scores_kind
    CHECK (score_kind IN ('functional', 'pain', 'rom', 'gait', 'endurance', 'strength', 'custom')),
  CONSTRAINT chk_physio_outcome_scores_value
    CHECK (score_value >= 0),
  CONSTRAINT chk_physio_outcome_scores_percent
    CHECK (score_kind NOT IN ('functional', 'rom', 'gait', 'endurance', 'strength') OR score_value <= 100),
  CONSTRAINT chk_physio_outcome_scores_pain
    CHECK (score_kind <> 'pain' OR score_value <= 10),
  CONSTRAINT chk_physio_outcome_scores_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_physio_outcome_scores_plan
  ON physio_outcome_scores (tenant_id, care_plan_id, score_kind, scored_at);

CREATE INDEX IF NOT EXISTS idx_physio_outcome_scores_patient
  ON physio_outcome_scores (tenant_id, patient_uid, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_physio_outcome_scores_session
  ON physio_outcome_scores (tenant_id, session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE physio_outcome_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE physio_outcome_scores FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON physio_outcome_scores;
CREATE POLICY tenant_isolation ON physio_outcome_scores
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
