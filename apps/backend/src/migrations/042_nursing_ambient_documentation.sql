-- Nursing Ambient Documentation.
--
-- Bedside nursing shift documentation from an ambient multi-speaker
-- transcript. Extracts structured observations: wound care, drains,
-- IV lines, intake/output, mobility, falls, shift summary, handover,
-- and patient education. Review-only; never changes orders.

CREATE TABLE IF NOT EXISTS clinical_nursing_ambient_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  nurse_uid UUID,
  shift VARCHAR(20) NOT NULL DEFAULT 'day'
    CHECK (shift IN ('day', 'evening', 'night', 'custom')),
  recording_started_at TIMESTAMPTZ NOT NULL,
  recording_ended_at TIMESTAMPTZ,
  duration_seconds NUMERIC(8, 2),
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
  transcript_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
  nursing_note_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days')
);

CREATE INDEX IF NOT EXISTS idx_nursing_ambient_tenant_patient
  ON clinical_nursing_ambient_sessions (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nursing_ambient_admission
  ON clinical_nursing_ambient_sessions (tenant_id, admission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nursing_ambient_decision
  ON clinical_nursing_ambient_sessions (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nursing_ambient_retention
  ON clinical_nursing_ambient_sessions (retention_until);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('nursing_ambient_documentation',
   'Nursing Ambient Documentation',
   'Bedside nursing shift documentation from an ambient multi-speaker transcript. Extracts structured observations — wounds, drains, IV lines, intake/output, mobility, falls, shift summary, handover, and patient education — and queues a clinician-reviewable draft. Never auto-changes orders or charts.',
   false,
   '{"surface":"clinical","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["NURSING_STAFF","DOCTOR","MEDICAL_RECORDS"],"approvalPolicy":"nursing_signoff","outputSchema":{"type":"object","required":["shift_summary","wounds","drains","iv_lines","intake_output","mobility","falls"]},"retentionDays":365,"rulesAuthoritative":true,"decisionSupportOnly":true}'::jsonb)
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
    'nursing_ambient_documentation',
    'v1',
    'Nursing Ambient Documentation v1',
    'You produce structured nursing shift documentation from a multi-speaker transcript. Use only transcript content. Return JSON only. Do not invent dosages, fluid totals, wound sizes, or fall times.',
    'Given transcript segments and rule-based observations, return keys: shift_summary, wounds, drains, iv_lines, intake_output, mobility, falls, handover_notes, patient_education. Every non-trivial field must cite the transcript segment index(es). Never change orders.',
    '{"type":"object","required":["shift_summary","wounds","drains","iv_lines","intake_output","mobility","falls"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
