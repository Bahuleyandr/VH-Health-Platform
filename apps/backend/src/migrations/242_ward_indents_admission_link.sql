-- 234_ward_indents_admission_link.sql
--
-- Closes finding:
--   2026-05-17-inpatient-admission-pharmacy-05748c99
-- (root_cause_key: ward-indent-no-admission-fk)
--
-- A ward indent had no admission_id / encounter_id / patient_uid link,
-- so pharmacy could not filter the IPD issue queue by patient, the
-- ward charge sheet had no row to bill against, and allergy/comorbidity
-- cross-checks were impossible at issue time. The patient identity
-- lived only in a free-text `notes` field.
--
-- Add nullable admission_id (INTEGER, no FK — mirrors the pattern used
-- by 229 section 1 for e_prescriptions.admission_id and the existing
-- ward_id column), encounter_id (UUID, no FK), and patient_uid (UUID,
-- no FK). Partial indexes for the IPD queue filter paths.

BEGIN;

ALTER TABLE ward_indents
  ADD COLUMN IF NOT EXISTS admission_id INTEGER,
  ADD COLUMN IF NOT EXISTS encounter_id UUID,
  ADD COLUMN IF NOT EXISTS patient_uid  UUID;

CREATE INDEX IF NOT EXISTS idx_ward_indents_admission_id
  ON ward_indents(admission_id)
  WHERE admission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ward_indents_patient_uid
  ON ward_indents(patient_uid)
  WHERE patient_uid IS NOT NULL;

COMMIT;
