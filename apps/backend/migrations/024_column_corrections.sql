-- Migration 024: Column corrections — second pass after full cross-table audit
-- Fixes remaining column mismatches found in deep source audit (2026-04-04)
-- All IF NOT EXISTS guarded — safe to re-run

-- ===================================================================
-- 1. staff — add name, designation columns
--    Multiple controllers do SELECT s.name, s.designation FROM staff
--    (denormalized from users table — populated on staff creation)
-- ===================================================================
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS name          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS designation   VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_staff_name ON staff(name);


-- ===================================================================
-- 2. staff_attendance — add check_out_time
--    Used by: bulkAttendanceController, staffAdminDashboardController,
--             staffAdminAnalyticsController, staffAdminAttendanceController
-- ===================================================================
ALTER TABLE staff_attendance
  ADD COLUMN IF NOT EXISTS check_out_time TIMESTAMP WITHOUT TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_staff_attendance_check_out ON staff_attendance(check_out_time);


-- ===================================================================
-- 3. beds — add assigned_at
--    bedService and bedManagementService RETURNING clause includes assigned_at
-- ===================================================================
ALTER TABLE beds
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP WITHOUT TIME ZONE;


-- ===================================================================
-- 4. appointments — add patient_id (int FK to users.id)
--    appointmentWorkflowController JOINs: LEFT JOIN users p ON a.patient_id = p.id
--    dataExportRoutes SELECT patient_id FROM appointments
-- ===================================================================
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
