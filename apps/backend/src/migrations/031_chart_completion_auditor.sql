-- Chart Completion Auditor.
--
-- Medical-records/admin surface for finding missing or incomplete chart
-- documentation before discharge, billing, coding, audit, or handover work.
-- Decision-support only: no clinical state is changed by this table.

CREATE TABLE IF NOT EXISTS clinical_ai_chart_gap_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  completion_score INTEGER NOT NULL DEFAULT 0 CHECK (completion_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'medium', 'high', 'critical', 'unknown')),
  gap_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chart_gap_audits_tenant_created
  ON clinical_ai_chart_gap_audits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chart_gap_audits_admission
  ON clinical_ai_chart_gap_audits (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chart_gap_audits_patient
  ON clinical_ai_chart_gap_audits (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chart_gap_audits_review
  ON clinical_ai_chart_gap_audits (tenant_id, reviewer_decision, risk_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('chart_completion_auditor',
   'Chart Completion Auditor',
   'Scores admission chart completeness and highlights unsigned notes, missing identifiers, pending investigations, active orders, missing discharge artefacts, and review blockers.',
   false,
   '{"surface":"medical_records","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["MEDICAL_RECORDS","DOCTOR","NURSING_STAFF","BILLING_STAFF"],"approvalPolicy":"chart_gap_review","outputSchema":{"type":"object","required":["completion_score","risk_band","gaps","recommendations"]},"retentionDays":3650}'::jsonb)
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
    'chart_completion_auditor',
    'v1',
    'Chart Completion Auditor v1',
    'You review hospital chart-completion evidence. Use only supplied chart signals and deterministic gap findings. Return JSON only. Never claim a chart is complete if evidence is missing. Treat all output as draft-only for human review.',
    'Given the chart packet and rule-based gaps, return keys: completion_score, risk_band, gaps, recommendations, summary, source_citations, safety_flags.',
    '{"type":"object","required":["completion_score","risk_band","gaps","recommendations"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
