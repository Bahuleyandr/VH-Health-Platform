-- 031_patient_vitals_mood.sql
-- Adds an optional mood field to the patient_vitals table so the daily
-- check-in modal on the patient dashboard can persist how the patient
-- feels alongside any quick vital signs they log.

ALTER TABLE patient_vitals
  ADD COLUMN IF NOT EXISTS mood VARCHAR(16);

-- No index required — mood is not queried in isolation today; it travels with
-- the rest of a patient's vitals row.
