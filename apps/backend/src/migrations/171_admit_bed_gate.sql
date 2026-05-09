-- 171_admit_bed_gate.sql
--
-- Bed-allocation gate at admit time. Tracks the timestamp at which a
-- bedless emergency admission was created so dashboards / SLA reports
-- can surface stale rows (door-time-to-bed metric).
--
-- Per project decision 2026-05-09:
--   - All admissions REQUIRE a bed at admit time, EXCEPT emergencies
--     where admission_type='emergency' AND priority='emergent' — those
--     may be admitted bedless temporarily; bed_pending_since stamps the
--     entry into that state.
--   - Day-care admissions go to a separate bed pool (beds.bed_type='day_care');
--     enforced at the service edge.
--
-- Finding: 2026-05-08-emergency-walk-in-doctor-admit-without-bed-allowed.

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS bed_pending_since TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_admissions_bed_pending
  ON admissions(bed_pending_since)
  WHERE bed_pending_since IS NOT NULL AND bed_id IS NULL;

COMMIT;
