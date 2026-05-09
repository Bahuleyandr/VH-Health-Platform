-- 190_followup_opd_polish.sql
--
-- E-10 — follow-up OPD operational fields.
--
-- Closes:
--   2026-05-08-follow-up-opd-doctor-no-visit-type-flag
--     Adds appointments.visit_type enum + parent_appointment_id link.
--
-- The other four follow-up-opd findings are service-layer fixes
-- (status update preserves patient_name; walk-in honours time;
-- progress-note POST endpoint; completed-visit content joiner).

BEGIN;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS visit_type           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS parent_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_visit_type_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_visit_type_check
      CHECK (visit_type IS NULL OR visit_type IN ('NEW', 'FOLLOW_UP', 'EMERGENCY', 'TELE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_appointments_visit_type
  ON appointments(visit_type)
  WHERE visit_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_parent
  ON appointments(parent_appointment_id)
  WHERE parent_appointment_id IS NOT NULL;

COMMIT;
