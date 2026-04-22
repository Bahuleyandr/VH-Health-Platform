-- Sepsis Bundle Sentinel.
--
-- Decision-support surface for suspected sepsis bundle completion. It checks
-- cited vitals, lactate/culture evidence, antimicrobial exposure, and
-- resuscitation signals. It never places orders or changes escalation state.

CREATE TABLE IF NOT EXISTS clinical_ai_sepsis_bundle_audits (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id INTEGER NOT NULL,
  patient_uid UUID,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'medium', 'high', 'critical', 'unknown')),
  criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundle_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_decision VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'acknowledged', 'escalated', 'dismissed')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sepsis_bundle_tenant_created
  ON clinical_ai_sepsis_bundle_audits (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sepsis_bundle_admission
  ON clinical_ai_sepsis_bundle_audits (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sepsis_bundle_patient
  ON clinical_ai_sepsis_bundle_audits (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sepsis_bundle_review
  ON clinical_ai_sepsis_bundle_audits (tenant_id, reviewer_decision, risk_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('sepsis_bundle_sentinel',
   'Sepsis Bundle Sentinel',
   'Audits suspected sepsis bundle completion from cited vitals, lactate/culture evidence, antibiotics, fluids, and vasopressor signals.',
   false,
   '{"surface":"clinical_safety","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","ICU_TEAM","ADMIN"],"approvalPolicy":"sepsis_bundle_review","outputSchema":{"type":"object","required":["risk_score","risk_band","criteria","bundle_gaps","recommendations"]},"retentionDays":3650}'::jsonb)
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
    'sepsis_bundle_sentinel',
    'v1',
    'Sepsis Bundle Sentinel v1',
    'You support sepsis bundle review. Use only supplied chart evidence and deterministic rule signals. Return JSON only. Never diagnose sepsis without cited evidence and never issue automatic orders.',
    'Given the chart packet and rule-based sepsis bundle findings, return keys: risk_score, risk_band, criteria, bundle_gaps, recommendations, summary, source_citations, safety_flags.',
    '{"type":"object","required":["risk_score","risk_band","criteria","bundle_gaps","recommendations"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
