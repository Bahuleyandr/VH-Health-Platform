-- Patient Teach-Back / Comprehension AI.
--
-- Comprehension-check loop applied after discharge/aftercare instructions are
-- generated. The AI asks simple questions in the patient's language and flags
-- misunderstanding. Review-only: it never alters orders, meds, or instructions.

CREATE TABLE IF NOT EXISTS clinical_ai_teach_back_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  source_generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  status VARCHAR(40) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_progress', 'completed', 'needs_clinician_review')),
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  patient_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  misunderstanding_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  comprehension_score INTEGER NOT NULL DEFAULT 0
    CHECK (comprehension_score BETWEEN 0 AND 100),
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

CREATE INDEX IF NOT EXISTS idx_teach_back_sessions_tenant_created
  ON clinical_ai_teach_back_sessions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_teach_back_sessions_admission
  ON clinical_ai_teach_back_sessions (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_teach_back_sessions_patient
  ON clinical_ai_teach_back_sessions (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_teach_back_sessions_review
  ON clinical_ai_teach_back_sessions (tenant_id, reviewer_decision, status, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('patient_teach_back_comprehension',
   'Patient Teach-Back / Comprehension AI',
   'Post-discharge/aftercare patient comprehension loop: asks simple language-appropriate questions about medications, warning signs, follow-up, diet/activity, wound care, and emergency escalation, and flags misunderstandings for clinician review. Never alters care plans.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["questions","comprehension_score","misunderstanding_flags"]},"retentionDays":1095,"rulesAuthoritative":true,"decisionSupportOnly":true,"supported_languages":["en","hi","ta","te","ml","mr","bn","kn"]}'::jsonb)
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
    'patient_teach_back_comprehension',
    'v1',
    'Patient Teach-Back Comprehension v1',
    'You run a patient comprehension teach-back. Use only supplied discharge/aftercare evidence. Return JSON only. Do not change care plans, medications, or instructions. Phrase questions in the requested language at a low reading level.',
    'Given the aftercare packet and rule-based teach-back draft, return keys: summary, questions, misunderstanding_flags, comprehension_score, source_citations, safety_flags. Every question must cite the underlying instruction/evidence. Never give new medical advice; only check understanding.',
    '{"type":"object","required":["questions","comprehension_score","misunderstanding_flags"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
