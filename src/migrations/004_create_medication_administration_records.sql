-- Adds 5-rights verification audit columns to the existing
-- medication_administrations table (schedule/administer/miss/hold lives here).
-- Each scan-backed administration records the scanned identifiers, which of
-- the five rights passed, and any override reason if the nurse pressed
-- through a rights failure.
--
-- Back-compat: existing callers that don't supply scan data continue to work;
-- the new columns are all nullable.

ALTER TABLE medication_administrations
  ADD COLUMN IF NOT EXISTS scanned_patient_uid  UUID,
  ADD COLUMN IF NOT EXISTS scanned_barcode      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS rights_passed        JSONB,
  ADD COLUMN IF NOT EXISTS all_rights_passed    BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_reason      TEXT,
  ADD COLUMN IF NOT EXISTS medication_index     INTEGER;

CREATE INDEX IF NOT EXISTS idx_med_admin_patient_time
  ON medication_administrations(patient_uid, administered_at DESC);
