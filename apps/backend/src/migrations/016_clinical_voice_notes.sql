-- Voice-to-SOAP — bedside dictation pipeline.
--
-- Stores the audio reference (R2 key or local path), the transcript (once
-- STT completes), and a link to any generated clinical AI draft. The raw
-- audio itself lives in R2; this table keeps the metadata + transcript
-- on-cluster. Retention defaults to 30 days to minimize PHI surface.

CREATE TABLE IF NOT EXISTS clinical_voice_notes (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recorded_by UUID,
  patient_uid UUID,
  admission_id INTEGER,
  audio_storage_key VARCHAR(500),
  audio_mime VARCHAR(60),
  audio_duration_seconds NUMERIC(6, 2),
  stt_provider VARCHAR(40) NOT NULL DEFAULT 'none',
  stt_model VARCHAR(120),
  stt_language VARCHAR(12),
  transcript TEXT,
  transcript_status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'completed', 'failed', 'skipped')),
  transcript_failure_reason TEXT,
  generation_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_voice_notes_tenant_recorder
  ON clinical_voice_notes (tenant_id, recorded_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_voice_notes_patient
  ON clinical_voice_notes (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_voice_notes_retention
  ON clinical_voice_notes (retention_until);

-- Seed the soap_from_dictation module. All configurable per-tenant via
-- clinical_ai_tenant_modules; here we only register the global SKU entry.
INSERT INTO clinical_ai_modules
  (module_key, display_name, description, enabled, settings)
VALUES
  ('soap_from_dictation',
   'SOAP from Dictation',
   'Bedside dictation transcribed to a structured SOAP draft. Draft enters the review queue; clinician must confirm before it becomes part of the chart.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","MEDICAL_RECORDS"],"approvalPolicy":"clinician_signoff","outputSchema":{"type":"object","required":["subjective","objective","assessment","plan"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
