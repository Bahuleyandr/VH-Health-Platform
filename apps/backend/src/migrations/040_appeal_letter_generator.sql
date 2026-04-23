-- Appeal Letter Generator for Denied Claims.
--
-- Generates a payer-specific appeal letter draft for a denied insurance
-- claim: medical necessity narrative, clinical evidence bundle, citation
-- set, and requested action. Billing/insurance coordinator reviews, edits,
-- and submits. Never auto-submits; payer outcomes are tracked as status
-- transitions without automatic claim write-off.

CREATE TABLE IF NOT EXISTS clinical_ai_appeal_letters (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  denial_reason TEXT,
  denial_code VARCHAR(80),
  denial_classification VARCHAR(60) NOT NULL DEFAULT 'other'
    CHECK (denial_classification IN (
      'medical_necessity', 'coding_error', 'prior_auth_missing',
      'documentation_insufficient', 'duplicate_claim', 'coverage',
      'timely_filing', 'bundled_service', 'non_covered_service',
      'other'
    )),
  appeal_type VARCHAR(40) NOT NULL DEFAULT 'first_level'
    CHECK (appeal_type IN ('first_level', 'second_level', 'external_review', 'reconsideration')),
  letter_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  clinical_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  appeal_status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (appeal_status IN ('draft', 'ready_for_submission', 'submitted', 'approved', 'denied', 'withdrawn')),
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID,
  payer_reference_id VARCHAR(120),
  payer_response JSONB,
  payer_response_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2555 days')
);

CREATE INDEX IF NOT EXISTS idx_appeal_letters_tenant_created
  ON clinical_ai_appeal_letters (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeal_letters_claim
  ON clinical_ai_appeal_letters (tenant_id, claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeal_letters_patient
  ON clinical_ai_appeal_letters (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeal_letters_status_review
  ON clinical_ai_appeal_letters (tenant_id, appeal_status, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeal_letters_submitted
  ON clinical_ai_appeal_letters (tenant_id, submitted_at DESC)
  WHERE appeal_status = 'submitted';

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('appeal_letter_generator',
   'Appeal Letter Generator for Denied Claims',
   'Drafts a payer-specific appeal letter for a denied insurance claim from cited chart evidence. Billing/insurance coordinator reviews, edits, and submits; the module never auto-submits and tracks payer outcomes without automatic claim write-off.',
   false,
   '{"surface":"revenue_cycle","risk":"medium","status":"available","requiresClinicianSignoff":false,"requiresCitations":true,"reviewRoles":["BILLING_STAFF","INSURANCE_COORDINATOR","MEDICAL_RECORDS","ADMIN"],"approvalPolicy":"revenue_cycle_review","outputSchema":{"type":"object","required":["cover_letter","medical_necessity","clinical_evidence","requested_action"]},"retentionDays":2555,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'appeal_letter_generator',
    'v1',
    'Appeal Letter Generator v1',
    'You draft payer appeal letters for denied insurance claims. Use only supplied claim and chart evidence. Return JSON only. Do not invent clinical facts, codes, or policy citations. The output is a draft; a human billing coordinator reviews and submits.',
    'Given the denied claim, denial reason/code classification, and clinical evidence bundle, return keys: cover_letter, medical_necessity, clinical_evidence, supporting_documentation, requested_action, procedure_codes, diagnosis_codes, source_citations, safety_flags. Keep medical_necessity <= 500 words; attach diagnosis/procedure codes verbatim from chart.',
    '{"type":"object","required":["cover_letter","medical_necessity","clinical_evidence","requested_action"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
