-- Multilingual patient outputs (M4).
--
-- Adds the per-user preferred_language pointer and a translations table that
-- stores the Indic-language (or other) rendering of an accepted clinical AI
-- draft. Translation is REVIEW-GATED — we never translate an unreviewed
-- draft, because translating a hallucinating draft just produces a
-- multilingual hallucination. See translationService.translateGeneration.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'preferred_language'
  ) THEN
    ALTER TABLE users ADD COLUMN preferred_language VARCHAR(5) NOT NULL DEFAULT 'en';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_preferred_language
  ON users (preferred_language);

CREATE TABLE IF NOT EXISTS clinical_ai_translations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_generation_id INTEGER NOT NULL REFERENCES clinical_ai_generations(id) ON DELETE CASCADE,
  source_language VARCHAR(5) NOT NULL DEFAULT 'en',
  target_language VARCHAR(5) NOT NULL,
  provider VARCHAR(40) NOT NULL,
  model VARCHAR(120),
  translated_draft JSONB NOT NULL,
  fidelity_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'failed', 'needs_review')),
  requested_by UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_generation_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_clinical_ai_translations_tenant_lang
  ON clinical_ai_translations (tenant_id, target_language, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ai_translations_source
  ON clinical_ai_translations (source_generation_id);

-- Seed the translation module SKU. Tenants enable it via the tenant-module
-- override table in M0; globally disabled until hospital opts in.
INSERT INTO clinical_ai_modules
  (module_key, display_name, description, enabled, settings)
VALUES
  ('patient_communication_translation',
   'Patient Communication Translation',
   'Translates an accepted clinical AI draft (aftercare, discharge summary, referral letter) into the patient''s preferred language. Only runs on reviewer-accepted drafts; numeric + entity fidelity is verified before delivery.',
   false,
   '{"surface":"patient","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"clinician_review_required","outputSchema":{"type":"object"},"retentionDays":365,"supported_languages":["en","hi","ta","te","ml","mr","bn","kn"]}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
