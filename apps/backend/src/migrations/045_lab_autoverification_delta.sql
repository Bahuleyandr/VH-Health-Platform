-- Lab Autoverification / Delta Check Assistant.
--
-- Classifies each lab result (numeric or textual) against reference ranges,
-- critical thresholds, and a prior value for the same patient + test. Rules
-- are authoritative: the service emits a decision (auto_verify / hold_for_review
-- / critical / rejected / pending) plus suggested actions. Review-only —
-- Lab staff / Pathologist / Doctor must sign off before release; the service
-- never auto-releases, corrects, or repeats a lab result.

CREATE TABLE IF NOT EXISTS clinical_ai_lab_autoverifications (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  investigation_id INTEGER REFERENCES investigations(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  test_name VARCHAR(200) NOT NULL,
  result_value NUMERIC(14, 4),
  result_text TEXT,
  units VARCHAR(40),
  prior_value NUMERIC(14, 4),
  prior_recorded_at TIMESTAMPTZ,
  delta_pct NUMERIC(8, 2),
  reference_low NUMERIC(14, 4),
  reference_high NUMERIC(14, 4),
  critical_low NUMERIC(14, 4),
  critical_high NUMERIC(14, 4),
  critical_band VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (critical_band IN ('normal', 'borderline_low', 'borderline_high', 'critical_low', 'critical_high', 'unknown')),
  decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('auto_verify', 'hold_for_review', 'critical', 'rejected', 'pending')),
  decision_reason TEXT,
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1825 days')
);

CREATE INDEX IF NOT EXISTS idx_lab_autoverifications_tenant_created
  ON clinical_ai_lab_autoverifications (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_autoverifications_patient
  ON clinical_ai_lab_autoverifications (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_autoverifications_decision
  ON clinical_ai_lab_autoverifications (tenant_id, decision, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lab_autoverifications_critical_band
  ON clinical_ai_lab_autoverifications (tenant_id, critical_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('lab_autoverification_delta',
   'Lab Autoverification / Delta Check Assistant',
   'Classifies lab results against reference ranges, critical thresholds, and the patient''s prior value for the same test. Emits an auto_verify / hold_for_review / critical decision plus suggested actions. Review-only — lab staff, pathologist, or doctor must sign off before release; the service never auto-releases, corrects, or repeats a result.',
   false,
   '{"surface":"lab","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["LAB_STAFF","DOCTOR","PATHOLOGIST","ADMIN"],"approvalPolicy":"lab_review","outputSchema":{"type":"object","required":["decision","critical_band","test_name"]},"retentionDays":1825,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();

INSERT INTO clinical_ai_prompts
  (tenant_id, module_key, version, title, system_prompt, user_prompt_template, output_schema, status, active, activated_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'lab_autoverification_delta',
    'v1',
    'Lab Autoverification / Delta Check Assistant v1',
    'You support lab autoverification review. Rules are authoritative. Use only the supplied lab result, reference range, critical thresholds, and prior value. Return JSON only. Never auto-release, correct, or repeat a lab result.',
    'Given the lab result, reference range, critical thresholds, and prior value, return keys: summary, decision_reason, suggested_actions, source_citations, safety_flags. Every safety flag must cite source evidence where possible.',
    '{"type":"object","required":["decision","critical_band","test_name"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
