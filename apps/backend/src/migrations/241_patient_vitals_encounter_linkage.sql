-- 241_patient_vitals_encounter_linkage.sql
--
-- Closes finding:
--   2026-05-17-inpatient-admission-nurse-af069182
--
-- Ward vitals recorded during an inpatient admission landed in
-- patient_vitals with only patient_uid set — recordStaffVitals silently
-- dropped admission_id / encounter_id, so the doctor's IPD chart could
-- not filter "vitals during this admission" reliably and trend charts
-- mixed OPD-era and inpatient values.
--
-- Add nullable admission_id (INTEGER, mirrors how e_prescriptions and
-- clinical_orders carry the link without a Prisma relation) and
-- encounter_id (UUID, matches admissions.encounter_id /
-- clinical_notes.encounter_id) on patient_vitals. Partial indexes —
-- only IPD/encounter-linked rows are queried by these — keep them small
-- and invisible to `prisma db pull` so schema.prisma carries just the
-- columns.

BEGIN;

ALTER TABLE patient_vitals
  ADD COLUMN IF NOT EXISTS admission_id INTEGER,
  ADD COLUMN IF NOT EXISTS encounter_id UUID;

CREATE INDEX IF NOT EXISTS idx_patient_vitals_admission_id
  ON patient_vitals(admission_id)
  WHERE admission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_vitals_encounter_id
  ON patient_vitals(encounter_id)
  WHERE encounter_id IS NOT NULL;

COMMIT;
