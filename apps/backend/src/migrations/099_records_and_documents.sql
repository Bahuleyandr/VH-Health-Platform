-- Migration 099: appointment_documents + patient_records.
--
-- Backs the "Hospital Docs" + "My Uploads" tabs in the patient Your
-- Health screen, plus the doctor-uploaded follow-up document flow.
-- Both tables were referenced from appointmentDocumentController but
-- never created — the controller was returning empty arrays via a
-- 42P01 catch.
--
-- appointment_documents — anything a doctor or staff member uploads
-- attached to a specific appointment (prescriptions, lab orders,
-- discharge summaries, follow-up advice). Visible to the patient by
-- default; clinical staff can mark `is_visible_to_patient = false`
-- for internal-only notes.
--
-- patient_records — patient-uploaded documents (insurance cards,
-- pre-existing reports from outside hospitals, vaccination records).
-- These never join to an appointment.

BEGIN;

-- ─── appointment_documents ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointment_documents (
  id                     BIGSERIAL PRIMARY KEY,
  appointment_id         INTEGER NOT NULL,
  patient_id             INTEGER NOT NULL,
  doctor_id              INTEGER,
  uploaded_by            INTEGER,
  upload_role            VARCHAR(40),
  document_type          VARCHAR(80),
  file_key               TEXT NOT NULL,
  file_url               TEXT,
  file_name              TEXT,
  file_size              BIGINT,
  file_mime              VARCHAR(100),
  notes                  TEXT,
  is_visible_to_patient  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT apptdocs_appointment_fk
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT apptdocs_patient_fk
    FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT apptdocs_doctor_fk
    FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT apptdocs_uploader_fk
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_apptdocs_patient_visible
  ON appointment_documents(patient_id) WHERE is_visible_to_patient = TRUE;

CREATE INDEX IF NOT EXISTS idx_apptdocs_appointment
  ON appointment_documents(appointment_id);

-- ─── patient_records ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_records (
  id              BIGSERIAL PRIMARY KEY,
  patient_id      INTEGER NOT NULL,
  document_type   VARCHAR(80),
  title           VARCHAR(255),
  file_key        TEXT NOT NULL,
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  file_mime       VARCHAR(100),
  source_hospital VARCHAR(255),
  record_date     DATE,
  notes           TEXT,
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT patrec_patient_fk
    FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patrec_patient_created
  ON patient_records(patient_id, created_at DESC);

COMMIT;
