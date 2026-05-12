-- 192_bed_cleaning_status.sql
-- Final discharge moves a vacated inpatient bed to cleaning while
-- housekeeping turns it over. Older databases may still have the initial
-- beds.status CHECK that allowed only available/occupied/reserved/maintenance.

ALTER TABLE beds
  DROP CONSTRAINT IF EXISTS beds_status_check;

ALTER TABLE beds
  ADD CONSTRAINT beds_status_check
  CHECK (status IN ('available', 'occupied', 'reserved', 'maintenance', 'cleaning', 'dirty'));
