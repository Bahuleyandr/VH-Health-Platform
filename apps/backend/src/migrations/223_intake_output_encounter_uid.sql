-- 223_intake_output_encounter_uid.sql
--
-- Wave-4B-2 — wire intake_output to the admission encounter via UUID.
--
-- Closes finding:
--   2026-05-09-inpatient-admission-nurse-io-encounter-uuid-500
--
-- Background: same shape as migration 208 (vitals_chart). Admission
-- encounter_id is a UUID; nurses recording fluid balance after copying
-- the encounter from an IPD admission hit a 500 because
-- intake_output.encounter_id was created as INTEGER for the pre-admission
-- HL7 visit_no path. recordIntakeOutput passed the UUID string directly
-- to Prisma, which threw an unhandled validation error.
--
-- Fix: add a sibling encounter_uid UUID column. Read paths prefer
-- encounter_uid when set; the legacy int encounter_id stays additive
-- for any caller still resolving the old HL7 visit_no path.
--
-- Backfill: match every existing intake_output row whose recorded_at
-- falls inside an admission window. Best-effort — orphan rows (no
-- matching admission) stay NULL.

BEGIN;

ALTER TABLE intake_output
  ADD COLUMN IF NOT EXISTS encounter_uid UUID;

UPDATE intake_output io
   SET encounter_uid = (
     SELECT a.encounter_id
       FROM admissions a
      WHERE a.patient_uid = io.patient_uid
        AND a.admitted_at IS NOT NULL
        AND a.encounter_id IS NOT NULL
        AND a.admitted_at <= COALESCE(io.recorded_at, io.created_at, NOW())
        AND (a.discharged_at IS NULL
             OR a.discharged_at >= COALESCE(io.recorded_at, io.created_at, NOW()))
      ORDER BY a.admitted_at DESC
      LIMIT 1
   )
 WHERE io.encounter_uid IS NULL;

CREATE INDEX IF NOT EXISTS idx_intake_output_encounter_uid
  ON intake_output(encounter_uid, recorded_at DESC)
  WHERE encounter_uid IS NOT NULL;

COMMIT;
