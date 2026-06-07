-- Link OP investigation orders back to the appointment/visit that created them.
-- This keeps OP Workspace, Patient Timeline, and audit views from inferring
-- visit context from patient + date alone.

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_investigations_appointment_id
  ON investigations (appointment_id)
  WHERE appointment_id IS NOT NULL;
