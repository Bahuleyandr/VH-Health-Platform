-- 217_lab_results_investigation_link.sql
--
-- Stage-3 chip G — link lab_results back to the doctor's
-- investigations order so result entry can transition the order out
-- of REQUESTED/SCHEDULED.
--
-- Finding: 2026-05-09-inpatient-admission-lab-tech-no-investigation-result-linkage.
--
-- Background. The doctor's order lives in `investigations` (id +
-- status + priority + requested_by). The lab tech's per-analyte
-- result lives in `lab_results`, keyed only by `booking_id` (an
-- investigation_bookings reference) and `patient_uid`. There was no
-- direct FK to the investigations row, so:
--   * The order's status never advanced past REQUESTED on result entry.
--   * The lab worklist (`investigations.status NOT IN ('COMPLETED','CANCELLED')`)
--     showed fulfilled orders forever.
--   * Joining a result back to "which order produced this" required
--     a fragile patient_uid + test_code match.
--
-- Migration adds a nullable FK column and an index. Historical rows
-- are NOT backfilled here — multi-row matches per patient (same test
-- code ordered repeatedly over time) need careful pairing logic that
-- doesn't belong in a DDL migration. The forward path (set on new
-- inserts in labResultsService) closes the gap for new traffic; a
-- separate schema-quality ticket can backfill if/when needed.

BEGIN;

ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS investigation_id INTEGER REFERENCES investigations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lab_results_investigation
  ON lab_results(investigation_id)
  WHERE investigation_id IS NOT NULL;

COMMIT;
