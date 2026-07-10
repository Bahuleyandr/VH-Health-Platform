-- NL-14 P2: structured trauma primary and secondary survey records.

BEGIN;

CREATE TABLE IF NOT EXISTS trauma_survey_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  trauma_activation_id BIGINT REFERENCES trauma_activations(id) ON DELETE SET NULL,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  survey_kind VARCHAR(24) NOT NULL,
  assessed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  assessed_by_uid UUID,
  responsible_clinician_uid UUID NOT NULL,
  airway TEXT,
  breathing TEXT,
  circulation TEXT,
  disability TEXT,
  exposure TEXT,
  fast_imaging JSONB NOT NULL DEFAULT '{}'::jsonb,
  interventions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reassessment_due_at TIMESTAMPTZ(6),
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  completion_status VARCHAR(24) NOT NULL DEFAULT 'draft',
  missing_required_fields TEXT[] NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ(6),
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT trauma_survey_records_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT trauma_survey_records_kind_check CHECK (
    survey_kind IN ('primary', 'secondary', 'reassessment')
  ),
  CONSTRAINT trauma_survey_records_status_check CHECK (
    completion_status IN ('draft', 'complete', 'amended', 'cancelled')
  ),
  CONSTRAINT trauma_survey_records_complete_requires_fields CHECK (
    completion_status <> 'complete'
    OR (
      airway IS NOT NULL
      AND breathing IS NOT NULL
      AND circulation IS NOT NULL
      AND disability IS NOT NULL
      AND exposure IS NOT NULL
      AND responsible_clinician_uid IS NOT NULL
      AND jsonb_array_length(source_citations) > 0
      AND cardinality(missing_required_fields) = 0
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_trauma_survey_activation
  ON trauma_survey_records (tenant_id, trauma_activation_id, assessed_at DESC)
  WHERE trauma_activation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trauma_survey_visit
  ON trauma_survey_records (tenant_id, emergency_visit_id, assessed_at DESC)
  WHERE emergency_visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trauma_survey_patient
  ON trauma_survey_records (tenant_id, patient_uid, assessed_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trauma_survey_completion
  ON trauma_survey_records (tenant_id, completion_status, assessed_at DESC);

ALTER TABLE trauma_survey_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE trauma_survey_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON trauma_survey_records;
CREATE POLICY tenant_isolation ON trauma_survey_records
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
