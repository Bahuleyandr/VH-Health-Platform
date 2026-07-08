-- 441_physio_sessions.sql
-- NL6-11: physiotherapy treatment session log with structured measures.

CREATE TABLE IF NOT EXISTS physio_sessions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  care_plan_id INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  assessment_id BIGINT REFERENCES physio_assessments(id) ON DELETE SET NULL,
  follow_up_plan_id INTEGER REFERENCES follow_up_plans(id) ON DELETE SET NULL,
  session_status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  session_type VARCHAR(40) NOT NULL DEFAULT 'therapy',
  scheduled_for TIMESTAMPTZ(6),
  started_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  therapist_uid UUID,
  duration_minutes INTEGER,
  pain_score_before INTEGER,
  pain_score_after INTEGER,
  rom_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  exercise_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  gait_balance_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  assistive_device VARCHAR(120),
  response_to_treatment TEXT,
  home_program TEXT,
  next_steps TEXT,
  outcome_score NUMERIC(5,2),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_physio_sessions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_physio_sessions_status
    CHECK (session_status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show')),
  CONSTRAINT chk_physio_sessions_type
    CHECK (session_type IN (
      'therapy', 'mobilisation', 'breathing_exercises', 'gait_training',
      'post_op_rehab', 'cardiac_rehab', 'neuro_rehab', 'education',
      'discharge_training', 'other'
    )),
  CONSTRAINT chk_physio_sessions_duration
    CHECK (duration_minutes IS NULL OR (duration_minutes >= 1 AND duration_minutes <= 480)),
  CONSTRAINT chk_physio_sessions_pain_before
    CHECK (pain_score_before IS NULL OR (pain_score_before >= 0 AND pain_score_before <= 10)),
  CONSTRAINT chk_physio_sessions_pain_after
    CHECK (pain_score_after IS NULL OR (pain_score_after >= 0 AND pain_score_after <= 10)),
  CONSTRAINT chk_physio_sessions_outcome_score
    CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 100)),
  CONSTRAINT chk_physio_sessions_rom_array
    CHECK (jsonb_typeof(rom_entries) = 'array'),
  CONSTRAINT chk_physio_sessions_exercise_array
    CHECK (jsonb_typeof(exercise_entries) = 'array'),
  CONSTRAINT chk_physio_sessions_gait_array
    CHECK (jsonb_typeof(gait_balance_entries) = 'array'),
  CONSTRAINT chk_physio_sessions_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_physio_sessions_plan
  ON physio_sessions (tenant_id, care_plan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_physio_sessions_patient
  ON physio_sessions (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_physio_sessions_status
  ON physio_sessions (tenant_id, session_status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_physio_sessions_therapist
  ON physio_sessions (tenant_id, therapist_uid, scheduled_for)
  WHERE therapist_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_physio_sessions_assessment
  ON physio_sessions (tenant_id, assessment_id)
  WHERE assessment_id IS NOT NULL;

ALTER TABLE physio_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE physio_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON physio_sessions;
CREATE POLICY tenant_isolation ON physio_sessions
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
