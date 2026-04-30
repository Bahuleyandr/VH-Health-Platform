-- Migration 117: Phase B1 — telemedicine foundation.
--
-- HEALTHCARE_AI_SPEC_AUDIT.md §25 flagged telemedicine as the largest
-- single functional gap: the patient app advertises teleconsultation,
-- but no entities exist to back it. This migration adds the
-- provider-agnostic foundation for video / chat / remote-prescription
-- workflows.
--
-- Tables:
--   1. teleconsultations           — top-level "remote consult" record
--                                     keyed by tenant + appointment.
--                                     One row per consult attempt.
--   2. video_sessions              — provider-specific session metadata
--                                     (Zoom / Daily.co / Jitsi / etc.)
--                                     with start/end + recording flags.
--   3. chat_sessions               — async chat thread for a teleconsult
--                                     (or standalone clinic chat). One
--                                     row per thread; messages live in
--                                     chat_session_messages.
--   4. chat_session_messages       — per-message rows. Stores body
--                                     (after sanitization happens
--                                     server-side), authored_by, role,
--                                     attachments JSONB.
--   5. remote_prescriptions        — prescriptions issued during a
--                                     teleconsult. Links back to the
--                                     parent consult + the existing
--                                     prescriptions table for billing.
--   6. teleconsult_provider_configs — per-tenant provider credentials
--                                     + defaults. Stored as ciphertext
--                                     placeholder (real encryption is a
--                                     separate task).
--
-- Decision-support only: nothing here auto-creates billing records or
-- auto-completes consultations. Patient + clinician explicitly start /
-- end via the routes. Teleconsultation lifecycle states gate all
-- transitions.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. teleconsultations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teleconsultations (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id              INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  patient_uid                 UUID,
  doctor_uid                  UUID,
  consult_type                VARCHAR(20) NOT NULL DEFAULT 'video'
    CHECK (consult_type IN ('video', 'chat', 'audio', 'hybrid')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show', 'failed')),
  scheduled_start             TIMESTAMPTZ,
  scheduled_end               TIMESTAMPTZ,
  actual_start                TIMESTAMPTZ,
  actual_end                  TIMESTAMPTZ,
  chief_complaint             TEXT,
  pre_consult_form            JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote_consent_id           VARCHAR(120),
  remote_consent_signed_at    TIMESTAMPTZ,
  ai_note_generation_id       INTEGER,
  ai_pre_visit_summary_id     INTEGER,
  recording_url               TEXT,
  recording_consent           BOOLEAN NOT NULL DEFAULT false,
  cancellation_reason         TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teleconsultations_tenant_status
  ON teleconsultations (tenant_id, status, scheduled_start DESC);
CREATE INDEX IF NOT EXISTS idx_teleconsultations_patient_status
  ON teleconsultations (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teleconsultations_doctor_window
  ON teleconsultations (tenant_id, doctor_uid, scheduled_start DESC)
  WHERE doctor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teleconsultations_appointment
  ON teleconsultations (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. video_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS video_sessions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teleconsultation_id         INTEGER NOT NULL REFERENCES teleconsultations(id) ON DELETE CASCADE,
  provider                    VARCHAR(40) NOT NULL
    CHECK (provider IN ('zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'other')),
  external_session_id         VARCHAR(255),
  patient_join_url            TEXT,
  doctor_join_url             TEXT,
  host_token                  TEXT,
  started_at                  TIMESTAMPTZ,
  ended_at                    TIMESTAMPTZ,
  duration_seconds            INTEGER,
  participant_count           INTEGER,
  bandwidth_kbps_avg          INTEGER,
  packet_loss_pct             NUMERIC(5,2),
  recording_id                VARCHAR(255),
  recording_status            VARCHAR(20)
    CHECK (recording_status IS NULL OR recording_status IN ('disabled', 'pending', 'available', 'failed', 'deleted')),
  status                      VARCHAR(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'ended', 'cancelled', 'failed')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_sessions_consult
  ON video_sessions (teleconsultation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_sessions_tenant_status
  ON video_sessions (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_sessions_external
  ON video_sessions (tenant_id, provider, external_session_id)
  WHERE external_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. chat_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teleconsultation_id         INTEGER REFERENCES teleconsultations(id) ON DELETE SET NULL,
  patient_uid                 UUID,
  doctor_uid                  UUID,
  topic                       VARCHAR(255),
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'archived')),
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at                   TIMESTAMPTZ,
  last_message_at             TIMESTAMPTZ,
  unread_count_patient        INTEGER NOT NULL DEFAULT 0,
  unread_count_doctor         INTEGER NOT NULL DEFAULT 0,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_status
  ON chat_sessions (tenant_id, status, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_patient
  ON chat_sessions (tenant_id, patient_uid, status)
  WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_doctor
  ON chat_sessions (tenant_id, doctor_uid, status)
  WHERE doctor_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_consult
  ON chat_sessions (teleconsultation_id)
  WHERE teleconsultation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. chat_session_messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_session_messages (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chat_session_id             INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  authored_by_uid             UUID,
  authored_role               VARCHAR(40) NOT NULL
    CHECK (authored_role IN ('patient', 'doctor', 'staff', 'system')),
  body                        TEXT NOT NULL,
  body_kind                   VARCHAR(20) NOT NULL DEFAULT 'text'
    CHECK (body_kind IN ('text', 'system_event', 'alert', 'attachment_card')),
  attachments                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  read_by_recipient_at        TIMESTAMPTZ,
  redacted                    BOOLEAN NOT NULL DEFAULT false,
  redacted_reason             VARCHAR(255),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_time
  ON chat_session_messages (chat_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant_unread
  ON chat_session_messages (tenant_id, chat_session_id, read_by_recipient_at)
  WHERE read_by_recipient_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. remote_prescriptions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_prescriptions (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teleconsultation_id         INTEGER NOT NULL REFERENCES teleconsultations(id) ON DELETE CASCADE,
  prescription_id             INTEGER,
  patient_uid                 UUID,
  doctor_uid                  UUID,
  issued_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'fulfilled', 'cancelled', 'recalled')),
  digital_signature_kind      VARCHAR(40)
    CHECK (digital_signature_kind IS NULL OR digital_signature_kind IN (
      'doctor_signed', 'aadhaar_esign', 'dsc', 'platform_attested', 'unsigned'
    )),
  digital_signature_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  pdf_url                     TEXT,
  cancellation_reason         TEXT,
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remote_rx_consult
  ON remote_prescriptions (teleconsultation_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_rx_tenant_status
  ON remote_prescriptions (tenant_id, status, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_remote_rx_patient
  ON remote_prescriptions (tenant_id, patient_uid, issued_at DESC)
  WHERE patient_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. teleconsult_provider_configs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teleconsult_provider_configs (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                    VARCHAR(40) NOT NULL
    CHECK (provider IN ('zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'other')),
  is_default                  BOOLEAN NOT NULL DEFAULT false,
  display_name                VARCHAR(160),
  api_key_ciphertext          TEXT,
  api_secret_ciphertext       TEXT,
  webhook_secret_ciphertext   TEXT,
  endpoint_base               TEXT,
  config                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'failed')),
  last_health_check_at        TIMESTAMPTZ,
  last_health_status          VARCHAR(20)
    CHECK (last_health_status IS NULL OR last_health_status IN ('ok', 'degraded', 'down')),
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                  UUID,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_config_default
  ON teleconsult_provider_configs (tenant_id)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_provider_configs_tenant_status
  ON teleconsult_provider_configs (tenant_id, status);

COMMIT;
