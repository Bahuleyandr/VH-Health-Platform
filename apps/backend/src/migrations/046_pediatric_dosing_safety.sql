-- Pediatric Dosing Safety AI.
--
-- Stores rules-authoritative pediatric dose checks for prescribed medications
-- against weight + age-based references. Decision-support only: the service
-- never writes, modifies, or holds prescription orders. Clinician/pharmacist
-- review is required before any action.

CREATE TABLE IF NOT EXISTS clinical_ai_pediatric_dose_checks (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prescription_id INTEGER,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  age_days INTEGER,
  weight_kg NUMERIC(6, 2),
  age_band VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (age_band IN ('neonate', 'infant', 'toddler', 'child', 'adolescent', 'adult', 'unknown')),
  medication_name VARCHAR(200) NOT NULL,
  prescribed_dose_mg NUMERIC(12, 3),
  prescribed_route VARCHAR(40),
  prescribed_frequency VARCHAR(60),
  max_dose_per_kg_mg NUMERIC(10, 3),
  absolute_max_dose_mg NUMERIC(12, 3),
  calculated_max_dose_mg NUMERIC(12, 3),
  variance_pct NUMERIC(8, 2),
  safety_band VARCHAR(30) NOT NULL DEFAULT 'unknown'
    CHECK (safety_band IN ('safe', 'caution', 'unsafe', 'missing_data', 'unknown')),
  rationale TEXT,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2555 days')
);

CREATE INDEX IF NOT EXISTS idx_pediatric_dose_tenant_created
  ON clinical_ai_pediatric_dose_checks (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pediatric_dose_tenant_patient_created
  ON clinical_ai_pediatric_dose_checks (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pediatric_dose_tenant_admission_created
  ON clinical_ai_pediatric_dose_checks (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pediatric_dose_tenant_safety_decision_created
  ON clinical_ai_pediatric_dose_checks (tenant_id, safety_band, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('pediatric_dosing_safety',
   'Pediatric Dosing Safety AI',
   'Evaluates pediatric prescription doses against weight + age-based references. Computes per-kg and absolute maximum doses, classifies safety band (safe/caution/unsafe/missing_data), and proposes reviewer actions. Rules are authoritative; review-only — the service never holds, modifies, or writes orders, and always requires clinician/pharmacist signoff before action.',
   false,
   '{"surface":"pharmacy","risk":"critical","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACIST","PHARMACY_STAFF","ADMIN"],"approvalPolicy":"pediatric_dose_review","outputSchema":{"type":"object","required":["safety_band","calculated_max_dose_mg","medication_name"]},"retentionDays":2555,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'pediatric_dosing_safety',
    'v1',
    'Pediatric Dosing Safety AI v1',
    'You support pediatric dose safety review. Rules are authoritative. Use only the supplied prescription, patient age, weight, and reference dose limits. Return JSON only. Never hold, cancel, or modify a prescription order; this is decision support only and clinician/pharmacist signoff is required before any action.',
    'Given the pediatric prescription, patient age and weight, reference dose limits, and rule-based safety evaluation, return keys: summary, rationale, suggested_actions, source_citations, safety_flags. Do not invent per-kg limits; defer to the supplied reference. If age or weight is missing, mark missing_data rather than assuming a default.',
    '{"type":"object","required":["safety_band","calculated_max_dose_mg","medication_name"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
