-- Migration 096: create medication_reminders table.
--
-- The patient app polls GET /api/v1/reminders/medication on every dashboard
-- load (and on background sync); the backing service in
-- patient/medicationReminderService.js queries `medication_reminders` via
-- raw SQL but the table never existed in the schema. Every poll has been
-- returning 500 in dev (and presumably prod), which the client treats as a
-- transient failure and triggers the "Connectivity changed: offline" path,
-- gating the rest of the UI.
--
-- Same shape as the gdpr_erasure_log + clinical_protocols misses caught in
-- batches 56 and 57.

BEGIN;

CREATE TABLE IF NOT EXISTS medication_reminders (
  id              BIGSERIAL PRIMARY KEY,
  patient_uid     UUID NOT NULL,
  medication_name VARCHAR(255) NOT NULL,
  dosage          VARCHAR(255),
  frequency       VARCHAR(100),
  reminder_times  TEXT[] NOT NULL DEFAULT '{}',
  start_date      DATE NOT NULL,
  end_date        DATE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT medication_reminders_patient_uid_fkey
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_medication_reminders_patient_uid_active
  ON medication_reminders(patient_uid)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_medication_reminders_start_date
  ON medication_reminders(start_date);

CREATE INDEX IF NOT EXISTS idx_medication_reminders_end_date
  ON medication_reminders(end_date)
  WHERE end_date IS NOT NULL;

COMMIT;
