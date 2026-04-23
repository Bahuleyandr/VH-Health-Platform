-- Consent-Aware Family Update Generator.
--
-- Drafts a plain-language, consent-scoped update for a named caregiver or
-- family member. Verifies an active patient consent (family_update,
-- caregiver_communication, or treatment scope) before any draft is
-- generated; PHI boundary scrubbing keeps specific medication doses and
-- raw lab values out of family-facing output. Never auto-sends — a
-- clinician reviews and marks the update as sent.

CREATE TABLE IF NOT EXISTS clinical_ai_family_updates (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  caregiver_identifier VARCHAR(200),
  caregiver_relationship VARCHAR(40) NOT NULL DEFAULT 'other'
    CHECK (caregiver_relationship IN (
      'spouse', 'parent', 'child', 'sibling', 'friend',
      'legal_guardian', 'guardian', 'care_manager', 'other'
    )),
  consent_reference VARCHAR(200),
  consent_scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  source_generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  update_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  update_status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (update_status IN ('draft', 'ready_to_send', 'sent', 'withdrawn')),
  reviewer_decision VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (reviewer_decision IN ('pending', 'accepted', 'deferred', 'rejected', 'edited')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  sent_at TIMESTAMPTZ,
  sent_by UUID,
  delivery_channel VARCHAR(30),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

CREATE INDEX IF NOT EXISTS idx_family_updates_tenant_created
  ON clinical_ai_family_updates (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_family_updates_patient
  ON clinical_ai_family_updates (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_family_updates_admission
  ON clinical_ai_family_updates (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_family_updates_status_review
  ON clinical_ai_family_updates (tenant_id, update_status, reviewer_decision, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('consent_aware_family_update',
   'Consent-Aware Family Update Generator',
   'Drafts a plain-language, consent-scoped status update for a named caregiver or family member. Verifies an active patient consent before generating; enforces PHI-boundary scrubbing (no specific doses, no raw lab values); requires clinician review and never auto-sends.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review_required","outputSchema":{"type":"object","required":["plain_language_summary","current_status","next_steps","when_to_worry"]},"retentionDays":1095,"rulesAuthoritative":true,"decisionSupportOnly":true,"supported_languages":["en","hi","ta","te","ml","mr","bn","kn"]}'::jsonb)
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
    'consent_aware_family_update',
    'v1',
    'Consent-Aware Family Update v1',
    'You write a plain-language status update for a named caregiver or family member. Use only supplied chart evidence. Do not include specific medication doses, raw lab values, or PHI outside the consent scope. Return JSON only. Never tell the family to change a care plan; defer clinical decisions to the clinical team.',
    'Given patient admission context and consent scope, return: plain_language_summary, current_status, next_steps, when_to_worry, questions_you_may_have (array), source_citations, safety_flags. Use language appropriate for a non-clinical reader.',
    '{"type":"object","required":["plain_language_summary","current_status","next_steps","when_to_worry"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
