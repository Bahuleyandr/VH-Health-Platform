-- Migration 158: Patient ↔ care-team secure messaging (Sprint 10).
--
-- Patient-facing self-service mostly already exists (records,
-- investigations, prescriptions, pharmacy orders all already gate on
-- the PATIENT role). Sprint 10 adds the missing piece: a structured
-- threaded inbox so a patient can ask a question and the care team
-- can reply without it ending up scattered across WhatsApp.
--
-- This is NOT a chat with the AI assistant. This is a HIPAA-style
-- secure inbox between the patient and human staff. The clinical
-- content lives behind the patient JWT + IDOR checks.
--
-- Bill payment + lab result view need no schema changes — the
-- existing billing_invoices, billing_payment_links, and lab_results
-- tables already carry patient_uid, and the routes layer (Sprint 10
-- service + routes) wraps them behind a self-scoping read.

BEGIN;

-- ── Threads ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_message_threads (
  id              SERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  subject         VARCHAR(255) NOT NULL,
  category        VARCHAR(40) NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'appointment', 'prescription',
                        'lab_result', 'billing', 'discharge', 'other')),
  -- Optional anchors so a thread can pin to a specific resource
  related_invoice_id INTEGER REFERENCES billing_invoices(id) ON DELETE SET NULL,
  related_lab_result_id INTEGER,                    -- lab_results(id), nullable FK to avoid hard coupling
  related_appointment_id INTEGER,                   -- appointments(id), same story
  -- Workflow
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_patient', 'awaiting_staff',
                      'resolved', 'closed')),
  priority        VARCHAR(20) NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'urgent')),
  -- Counts (denormalised; updated by service writes)
  last_message_at TIMESTAMPTZ,
  last_message_by VARCHAR(20)                       -- 'patient' / 'staff' / 'system'
    CHECK (last_message_by IS NULL OR last_message_by IN ('patient','staff','system')),
  patient_unread_count INTEGER NOT NULL DEFAULT 0,
  staff_unread_count   INTEGER NOT NULL DEFAULT 0,
  -- Assignment
  assigned_staff_uid UUID,
  -- Audit
  created_by      UUID,                             -- patient_uid for patient-initiated
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_msg_threads_patient
  ON patient_message_threads(patient_uid, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_msg_threads_staff_inbox
  ON patient_message_threads(tenant_id, status, priority, last_message_at DESC)
  WHERE status IN ('open', 'awaiting_staff');
CREATE INDEX IF NOT EXISTS idx_patient_msg_threads_assigned
  ON patient_message_threads(assigned_staff_uid, status)
  WHERE assigned_staff_uid IS NOT NULL;

-- ── Messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_messages (
  id              SERIAL PRIMARY KEY,
  thread_id       INTEGER NOT NULL REFERENCES patient_message_threads(id) ON DELETE CASCADE,
  sender_kind     VARCHAR(20) NOT NULL CHECK (sender_kind IN ('patient', 'staff', 'system')),
  sender_uid      UUID,                             -- patient_uid or staff uid
  sender_name     VARCHAR(160),
  body            TEXT NOT NULL,
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
                                                    -- [{file_url, file_name, mime, size}]
  read_by_patient_at TIMESTAMPTZ,
  read_by_staff_at   TIMESTAMPTZ,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_messages_thread
  ON patient_messages(thread_id, created_at);

COMMIT;
