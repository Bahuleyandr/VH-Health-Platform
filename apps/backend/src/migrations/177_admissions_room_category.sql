-- 177_admissions_room_category.sql
--
-- A12 — agreed-room-category capture at admit time. Distinct from
-- beds.bed_type (the actual bed assigned, which can differ when the
-- agreed category isn't immediately available). The admission record
-- needs the agreed category because:
--
--   1. Tariff varies by category — billing computes daily room charges
--      from this, not from the bed currently occupied (a patient
--      promised private but waiting in a general bed should still be
--      billed at their agreed rate once they upgrade).
--   2. TPA pre-auth is per-category — claims need the agreed value at
--      submission time, not whatever bed they happen to be in.
--   3. Patient app displays it as "Room: Private" — UI source of truth.
--
-- Allowed values mirror the bed_type seed set:
--   general | semi_private | private | deluxe | icu | day_care
--
-- Finding: 2026-05-08-inpatient-admission-admission-no-semiprivate-room-category
-- Architectural item A12.

BEGIN;

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS room_category VARCHAR(40);

-- Soft check (constraint name namespaced so it can be evolved).
-- Allowing NULL preserves historical rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admissions_room_category_check'
  ) THEN
    ALTER TABLE admissions
      ADD CONSTRAINT admissions_room_category_check
      CHECK (room_category IS NULL OR room_category IN
        ('general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care'));
  END IF;
END $$;

-- Backfill historicals from the joined bed.bed_type. Rows where the
-- bed is missing or has an unknown type stay NULL (which is valid).
UPDATE admissions a
   SET room_category = b.bed_type
  FROM beds b
 WHERE a.room_category IS NULL
   AND a.bed_id = b.id
   AND b.bed_type IN ('general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care');

CREATE INDEX IF NOT EXISTS idx_admissions_room_category
  ON admissions(room_category)
  WHERE room_category IS NOT NULL;

COMMIT;
