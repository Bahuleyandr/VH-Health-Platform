-- Voice Patient Assistant / IVR.
--
-- Consent-gated IVR / voice-assistant session classifier. Given a patient,
-- intent (`prep` / `aftercare` / `meds` / `reminder` / `virtual_ward` /
-- `triage_callback` / `other`), transcript text, consent_ref, channel
-- (ivr / phone / sms / chat), language, and an optional script_key,
-- classifies session safety: consent present + fresh (otherwise block),
-- transcript has urgent/emergency phrases (escalate to clinician),
-- candidate response has PHI leakage (block response + sanitize), intent
-- supported in configured scripts (otherwise fallback to human), language
-- supported (otherwise fallback). Emits a per-session recommendation —
-- `allow` / `escalate_to_clinician` / `block` / `fallback_to_human` /
-- `no_action`.
--
-- Rules are authoritative; review-only — a downstream dispatcher delivers
-- only after reviewer approval (or via an admin-approved template path).
-- The module itself never plays audio or sends a reply.

CREATE TABLE IF NOT EXISTS clinical_ai_voice_ivr_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  admission_id INTEGER,
  generation_id INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  intent VARCHAR(40) NOT NULL DEFAULT 'other'
    CHECK (intent IN ('prep', 'aftercare', 'meds', 'reminder', 'virtual_ward', 'triage_callback', 'other', 'unknown')),
  channel VARCHAR(30) NOT NULL DEFAULT 'ivr'
    CHECK (channel IN ('ivr', 'phone', 'sms', 'chat', 'unknown')),
  language VARCHAR(20) NOT NULL DEFAULT 'en',
  script_key VARCHAR(160),
  consent_ref VARCHAR(200),
  consent_fresh BOOLEAN NOT NULL DEFAULT FALSE,
  transcript_preview TEXT,
  sanitized_response TEXT,
  recommendation VARCHAR(40) NOT NULL DEFAULT 'no_action'
    CHECK (recommendation IN ('allow', 'escalate_to_clinician', 'block', 'fallback_to_human', 'no_action', 'unknown')),
  severity VARCHAR(20) NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'moderate', 'high', 'critical', 'unknown')),
  phi_leak_count INTEGER NOT NULL DEFAULT 0,
  urgent_signal_count INTEGER NOT NULL DEFAULT 0,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  retention_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_patient_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_rec_sev_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, recommendation, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_intent_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, intent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_channel_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_decision_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, reviewer_decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_ivr_sessions_tenant_created
  ON clinical_ai_voice_ivr_sessions (tenant_id, created_at DESC);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('voice_patient_assistant_ivr',
   'Voice Patient Assistant / IVR',
   'Consent-gated voice/IVR session classifier for patient-facing prep, aftercare, meds, reminders, virtual-ward check-ins, and triage callbacks. Given a transcript + intent + consent reference + candidate response, detects urgent/emergency phrases (escalate), PHI leakage risk in the candidate response (block + sanitize), missing or stale consent (block), unsupported language or intent (fallback to human). Emits a per-session recommendation — `allow` / `escalate_to_clinician` / `block` / `fallback_to_human` / `no_action`. Rules are authoritative; review-only — a downstream dispatcher delivers only after reviewer approval (or via admin-approved template path). The module itself never plays audio or sends a reply.',
   false,
   '{"surface":"patient_communication","risk":"high","status":"available","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","NURSE","ADMIN"],"approvalPolicy":"clinician_review","outputSchema":{"type":"object","required":["recommendation","severity"]},"retentionDays":1095,"rulesAuthoritative":true,"decisionSupportOnly":true,"consentRequired":true}'::jsonb)
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
    'voice_patient_assistant_ivr',
    'v1',
    'Voice Patient Assistant / IVR v1',
    'You support the clinician review of a consent-gated voice/IVR patient-assistant session. Rules are authoritative: consent presence + freshness, urgent/emergency phrases in the transcript, PHI leakage in the candidate response, language support, and intent/script support are evaluated by a deterministic rule-based classifier that emits recommendation (allow / escalate_to_clinician / block / fallback_to_human / no_action) and severity. Return JSON only. This module never plays audio, never sends a reply, and never dispatches a call — a downstream dispatcher delivers only after clinician review (or via an admin-approved template path).',
    'Given the session (patient, intent, channel, language, script_key, consent_ref + freshness, transcript preview, candidate response) and the rule-based recommendation, severity, urgent/PHI signal counts, and sanitized response, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation, severity, phi_leak_count, urgent_signal_count, or sanitized response. If any required field is missing, defer to the clinician reviewer rather than guessing.',
    '{"type":"object","required":["recommendation","severity"]}'::jsonb,
    'active',
    true,
    NOW()
  )
ON CONFLICT (module_key, version) DO NOTHING;
