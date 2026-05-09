-- 172_beds_admission_back_linking.sql
--
-- Bed-board back-linking. The beds row carries a denormalized snapshot of
-- who's currently in it so the bed-board view ("who's in 3-A?") can answer
-- without scanning admissions. patient_uid is already on beds; this
-- migration adds admission_id so we can also click through from a bed to
-- its admission cleanly.
--
-- Existing beds.patient_id/patient_name/admitted_at/expected_discharge
-- already cover most of the back-linking; the gap was admission_id and
-- ensuring all paths (admit, assign-bed, transfer, discharge) keep these
-- fields in sync. The service-side wiring lives in admissionService.
--
-- Finding: 2026-05-08-inpatient-admission-admission-bed-not-back-linked.

BEGIN;

ALTER TABLE beds
  ADD COLUMN IF NOT EXISTS admission_id INTEGER
    REFERENCES admissions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_beds_admission
  ON beds(admission_id)
  WHERE admission_id IS NOT NULL;

COMMIT;
