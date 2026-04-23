-- Antimicrobial Stewardship Assistant.
--
-- Review-only workflow for antibiotic duration, culture follow-up,
-- de-escalation, IV-to-oral switch, renal dosing, duplicate spectrum,
-- and allergy-risk checks. It never changes medication orders.

CREATE TABLE IF NOT EXISTS clinical_ai_antimicrobial_reviews (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID,
  admission_id INTEGER NOT NULL,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  stewardship_score INTEGER NOT NULL DEFAULT 0
    CHECK (stewardship_score BETWEEN 0 AND 100),
  risk_band VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (risk_band IN ('low', 'medium', 'high', 'critical', 'unknown')),
  antibiotic_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  culture_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  renal_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  fever_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS idx_antimicrobial_reviews_tenant_created
  ON clinical_ai_antimicrobial_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_antimicrobial_reviews_admission
  ON clinical_ai_antimicrobial_reviews (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_antimicrobial_reviews_patient
  ON clinical_ai_antimicrobial_reviews (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_antimicrobial_reviews_review_risk
  ON clinical_ai_antimicrobial_reviews (tenant_id, reviewer_decision, risk_band, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('antimicrobial_stewardship',
   'Antimicrobial Stewardship Assistant',
   'Reviews antibiotics against cultures, fever trend, renal function, allergies, duration, de-escalation, IV-to-oral switch, and duplicate spectrum from cited inpatient evidence.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF","INFECTION_CONTROL","NURSING_STAFF"],"approvalPolicy":"stewardship_review","outputSchema":{"type":"object","required":["stewardship_score","risk_band","flags","recommendations"]},"retentionDays":3650,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'antimicrobial_stewardship',
    'v1',
    'Antimicrobial Stewardship Assistant v1',
    'You support hospital antimicrobial stewardship. Use only supplied chart evidence. Return JSON only. Rules are authoritative; AI may summarize rationale and gaps but must not order, stop, or change medications.',
    'Given the chart packet and rule-based stewardship draft, return keys: summary, antibiotic_summary, culture_summary, renal_summary, fever_summary, flags, recommendations, source_citations, safety_flags. Every flag must cite source evidence where possible.',
    '{"type":"object","required":["stewardship_score","risk_band","flags","recommendations"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
