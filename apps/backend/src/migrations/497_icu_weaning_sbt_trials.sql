-- NL-14 P1: ICU weaning and spontaneous breathing trial records.
--
-- SBT readiness/outcomes are recorded as reviewed clinical facts. Protocol
-- availability must be supplied by governance/content; this table does not
-- encode hidden weaning formulas.

BEGIN;

CREATE TABLE IF NOT EXISTS icu_weaning_trials (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  icu_admission_id INTEGER NOT NULL REFERENCES icu_admissions(id) ON DELETE CASCADE,
  ventilation_episode_id BIGINT REFERENCES icu_ventilation_episodes(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE NO ACTION,
  trial_kind VARCHAR(30) NOT NULL DEFAULT 'sbt',
  readiness_status VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
  started_at TIMESTAMPTZ(6),
  ended_at TIMESTAMPTZ(6),
  outcome VARCHAR(30),
  reason TEXT,
  criteria_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  protocol_reference JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_uid UUID,
  reviewed_at TIMESTAMPTZ(6),
  recorded_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT icu_weaning_trial_kind_check CHECK (trial_kind IN ('sbt', 'awakening_trial', 'extubation_readiness')),
  CONSTRAINT icu_weaning_readiness_check CHECK (readiness_status IN ('ready', 'not_ready', 'contraindicated', 'not_assessed', 'protocol_unavailable')),
  CONSTRAINT icu_weaning_outcome_check CHECK (outcome IS NULL OR outcome IN ('passed', 'failed', 'stopped', 'extubated', 'deferred')),
  CONSTRAINT icu_weaning_time_check CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CONSTRAINT icu_weaning_review_check
    CHECK (readiness_status = 'protocol_unavailable' OR reviewer_uid IS NOT NULL),
  CONSTRAINT fk_icu_weaning_trials_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_icu_weaning_trials_admission
  ON icu_weaning_trials (tenant_id, icu_admission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_icu_weaning_trials_episode
  ON icu_weaning_trials (tenant_id, ventilation_episode_id)
  WHERE ventilation_episode_id IS NOT NULL;

ALTER TABLE icu_weaning_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE icu_weaning_trials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON icu_weaning_trials;
CREATE POLICY tenant_isolation ON icu_weaning_trials
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
