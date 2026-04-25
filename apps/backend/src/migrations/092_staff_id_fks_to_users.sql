-- Migration 092: batch-53 — declare staff_id → users.id FKs across the
-- HR table cluster. Closes the audit follow-up from batches 49-52.
--
-- Audit (dev + test DB at migration time): all 6 tables empty
-- (0 rows each), so the FK addition is data-safe with no
-- backfill / cleanup required.
--
-- Code audit (batches 49-52 ORM rewrites): every writer passes
-- users.id (Int) as the staff_id value. The column name is
-- historical — it predates the staff/users split and refers to
-- the user side, not the staff profile row. The FK target is
-- therefore users.id, not staff.id.
--
-- ON DELETE policy:
-- - staff_attendance.staff_id is NOT NULL → CASCADE (matches GDPR
--   right-to-erasure intent — user deletion takes their
--   attendance records too).
-- - All other tables (audit trails) are nullable → SET NULL to
--   preserve the historical row when the user is deleted.

BEGIN;

ALTER TABLE staff_attendance
  ADD CONSTRAINT staff_attendance_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE attendance_logs
  ADD CONSTRAINT attendance_logs_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE leave_applications
  ADD CONSTRAINT leave_applications_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE staff_performance_reviews
  ADD CONSTRAINT staff_performance_reviews_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE staff_onboarding_tasks
  ADD CONSTRAINT staff_onboarding_tasks_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE hr_activity_logs
  ADD CONSTRAINT hr_activity_logs_staff_id_fkey
  FOREIGN KEY (staff_id) REFERENCES users(id)
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- Match Prisma's auto-generated FK index pattern.
CREATE INDEX IF NOT EXISTS idx_staff_attendance_staff_id_fk ON staff_attendance(staff_id);
CREATE INDEX IF NOT EXISTS idx_attendance_logs_staff_id_fk ON attendance_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_leave_applications_staff_id_fk ON leave_applications(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_performance_reviews_staff_id_fk ON staff_performance_reviews(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_onboarding_tasks_staff_id_fk ON staff_onboarding_tasks(staff_id);
CREATE INDEX IF NOT EXISTS idx_hr_activity_logs_staff_id_fk ON hr_activity_logs(staff_id);

COMMIT;
