-- Ambient clinical documentation.
-- Full-encounter recording (with patient consent) → multi-speaker
-- transcript → structured visit note with speaker attribution.
-- Extends M3's voice-to-SOAP with diarization metadata.

CREATE TABLE IF NOT EXISTS clinical_ambient_encounters (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  recording_started_at TIMESTAMPTZ NOT NULL,
  recording_ended_at TIMESTAMPTZ,
  duration_seconds NUMERIC(8, 2),
  recorded_by UUID,
  clinician_uid UUID,
  consent_reference VARCHAR(200),
  audio_storage_key TEXT,
  audio_mime VARCHAR(60),
  stt_provider VARCHAR(40) NOT NULL DEFAULT 'none',
  stt_model VARCHAR(120),
  stt_language VARCHAR(12),
  diarization_provider VARCHAR(40),
  speaker_count INTEGER NOT NULL DEFAULT 0,
  transcript_status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (transcript_status IN ('pending', 'completed', 'failed', 'skipped')),
  transcript_failure_reason TEXT,
  transcript_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_clinical_ambient_encounters_tenant_patient
  ON clinical_ambient_encounters (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_ambient_encounters_retention
  ON clinical_ambient_encounters (retention_until);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('ambient_visit_documentation',
   'Ambient Visit Documentation',
   'Records the full doctor-patient encounter (with explicit patient consent), diarizes, and produces a structured visit note attributing each section to speaker (doctor / patient / caregiver). Draft enters the review queue; clinician signs off.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSING_STAFF","MEDICAL_RECORDS"],"approvalPolicy":"clinician_signoff","outputSchema":{"type":"object","required":["chief_complaint","hpi","assessment","plan"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
