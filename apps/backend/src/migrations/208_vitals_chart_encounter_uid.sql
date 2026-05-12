-- 208_vitals_chart_encounter_uid.sql
--
-- Wave-4B-1 — wire vitals to the admission encounter via UUID.
--
-- Closes finding:
--   2026-05-08-inpatient-admission-nurse-vitals-encounter-id-type-mismatch
--
-- Background: `admissions.encounter_id` is a UUID (`gen_random_uuid()` default),
-- but `vitals_chart.encounter_id` was created as `INTEGER` years ago for a
-- pre-admission HL7-driven encounters table that never landed. Every clinical
-- surface in this monorepo that emits the encounter does so as a UUID string;
-- nurses posting `POST /api/v1/emr/vitals` with the admission's
-- `encounter_id` got a Prisma type-validation 500. The workaround of dropping
-- the field stored orphan vitals (`encounter_id = NULL`), breaking
-- encounter-scoped reads in the doctor's round + discharge summary.
--
-- Fix: add a sibling `encounter_uid UUID` column to vitals_chart. Read paths
-- prefer encounter_uid when set; the legacy int `encounter_id` stays for any
-- callers still resolving the old HL7 visit_no path (none in this repo, but
-- removing it would break the existing additive contract).
--
-- Backfill: match every existing vitals row whose recorded_at falls inside
-- an admission window. Best-effort — there are admissions that share a
-- patient_uid with overlapping windows; the JOIN picks the *most recent*
-- admission as of recorded_at. Mismatches are acceptable (vitals were
-- orphan before this migration anyway).

BEGIN;

ALTER TABLE vitals_chart
  ADD COLUMN IF NOT EXISTS encounter_uid UUID;

-- Backfill from admissions windows. Pick the most recent admission whose
-- window contains the vitals row's recorded_at. Best-effort — orphan rows
-- (no matching admission) stay NULL; that matches the pre-migration shape.
UPDATE vitals_chart vc
   SET encounter_uid = (
     SELECT a.encounter_id
       FROM admissions a
      WHERE a.patient_uid = vc.patient_uid
        AND a.admitted_at IS NOT NULL
        AND a.encounter_id IS NOT NULL
        AND a.admitted_at <= COALESCE(vc.recorded_at, vc.created_at, NOW())
        AND (a.discharged_at IS NULL
             OR a.discharged_at >= COALESCE(vc.recorded_at, vc.created_at, NOW()))
      ORDER BY a.admitted_at DESC
      LIMIT 1
   )
 WHERE vc.encounter_uid IS NULL;

CREATE INDEX IF NOT EXISTS idx_vitals_chart_encounter_uid
  ON vitals_chart(encounter_uid, recorded_at DESC)
  WHERE encounter_uid IS NOT NULL;

COMMIT;
