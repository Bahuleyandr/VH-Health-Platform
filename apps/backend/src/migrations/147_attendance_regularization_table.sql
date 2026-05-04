-- Backing table for staff attendance regularization requests and bulk
-- correction audit logs. The controllers have referenced this table for a
-- while; keeping it in the migration stream prevents button flows from
-- failing only after deployment.

CREATE TABLE IF NOT EXISTS attendance_regularization (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  reason TEXT NOT NULL,
  requested_check_in TIMESTAMPTZ,
  requested_check_out TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_regularization_staff
  ON attendance_regularization(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_regularization_status
  ON attendance_regularization(status);
CREATE INDEX IF NOT EXISTS idx_attendance_regularization_reviewed_by
  ON attendance_regularization(reviewed_by);
