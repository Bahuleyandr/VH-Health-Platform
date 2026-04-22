-- Clinical AI modular surface, provider telemetry, and usage tracking.

CREATE TABLE IF NOT EXISTS clinical_ai_modules (
  module_key VARCHAR(80) PRIMARY KEY,
  display_name VARCHAR(160) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  provider_override VARCHAR(80),
  model_override VARCHAR(160),
  external_allowed BOOLEAN NOT NULL DEFAULT false,
  max_tokens INTEGER,
  temperature NUMERIC(4, 2),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_modules_enabled
  ON clinical_ai_modules(enabled, module_key);

INSERT INTO clinical_ai_modules
  (module_key, display_name, description, enabled, settings)
VALUES
  (
    'discharge_summary',
    'Discharge Summary Drafts',
    'Drafts clinician-reviewed discharge summaries from inpatient chart context.',
    true,
    '{"surface":"emr","risk":"high","requiresClinicianSignoff":true}'::jsonb
  ),
  (
    'handover_summary',
    'Nursing Handover Drafts',
    'Drafts shift handover notes from recent patient timeline events.',
    true,
    '{"surface":"clinical","risk":"medium","requiresClinicianSignoff":true}'::jsonb
  ),
  (
    'patient_record_summary',
    'Patient Record Summary',
    'Future module for longitudinal inpatient-record summaries across admissions.',
    false,
    '{"surface":"emr","risk":"high","status":"planned"}'::jsonb
  ),
  (
    'patient_aftercare_instructions',
    'Patient Aftercare Instructions',
    'Future module for patient-friendly discharge instructions with warning signs.',
    false,
    '{"surface":"patient","risk":"high","status":"planned"}'::jsonb
  ),
  (
    'clinical_coding_assist',
    'Clinical Coding Assistant',
    'Future module for ICD/CPT coding suggestions from signed clinical documentation.',
    false,
    '{"surface":"revenue_cycle","risk":"medium","status":"planned"}'::jsonb
  ),
  (
    'quality_case_review',
    'Quality Case Review',
    'Future module for readmission, mortality, and incident-review summaries.',
    false,
    '{"surface":"quality","risk":"medium","status":"planned"}'::jsonb
  )
ON CONFLICT (module_key) DO NOTHING;

ALTER TABLE clinical_ai_generations
  ADD COLUMN IF NOT EXISTS module_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_minor INTEGER,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS provider_request_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(80),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE clinical_ai_generations
SET module_key = task_type
WHERE module_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_ai_module_created
  ON clinical_ai_generations(module_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_provider_created
  ON clinical_ai_generations(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_usage_created
  ON clinical_ai_generations(created_at DESC, total_tokens);
