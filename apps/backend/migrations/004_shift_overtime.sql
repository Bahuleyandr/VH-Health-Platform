-- Add new columns to staff_attendance table
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(20);
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS minutes_late INTEGER;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(4,2) DEFAULT 0;

-- Shifts
CREATE TABLE IF NOT EXISTS staff_shifts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  start_time TIME NOT NULL,        -- e.g. '08:00'
  end_time TIME NOT NULL,          -- e.g. '17:00'
  grace_period_minutes INT DEFAULT 15,  -- within grace = on-time
  late_threshold_minutes INT DEFAULT 30, -- 30+ min late = late flag
  absent_threshold_minutes INT DEFAULT 60, -- 60+ = counted absent
  department VARCHAR(100),         -- NULL = all departments
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Assign shifts to staff
CREATE TABLE IF NOT EXISTS staff_shift_assignments (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES staff_shifts(id),
  effective_from DATE DEFAULT CURRENT_DATE,
  effective_to DATE,               -- NULL = ongoing
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_id, effective_from)
);

-- Pre-seed default shifts
INSERT INTO staff_shifts (name, start_time, end_time, grace_period_minutes, late_threshold_minutes, absent_threshold_minutes) VALUES
  ('Morning', '08:00', '17:00', 15, 30, 60),
  ('Evening', '16:00', '23:00', 15, 30, 60),
  ('Night',   '22:00', '07:00', 15, 30, 60)
ON CONFLICT DO NOTHING;

-- Overtime requests
CREATE TABLE IF NOT EXISTS overtime_requests (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id),
  date DATE NOT NULL,
  extra_hours NUMERIC(4,2) NOT NULL,
  reason TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'comp_time', -- comp_time / payment
  status VARCHAR(20) DEFAULT 'pending',
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Break tracking
CREATE TABLE IF NOT EXISTS staff_breaks (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER REFERENCES staff_attendance(id),
  staff_id INTEGER REFERENCES users(id),
  break_start TIMESTAMP NOT NULL,
  break_end TIMESTAMP,
  duration_minutes INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Attendance disputes (enhanced regularization)
CREATE TABLE IF NOT EXISTS attendance_disputes (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id),
  date DATE NOT NULL,
  dispute_type VARCHAR(50) NOT NULL, -- missed_checkin / missed_checkout / wrong_time / app_failure
  description TEXT NOT NULL,
  requested_check_in TIMESTAMP,
  requested_check_out TIMESTAMP,
  evidence_url TEXT,               -- photo of badge, location screenshot etc
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMP,
  reviewer_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_id, date)
);

-- Geo-fence breach log
CREATE TABLE IF NOT EXISTS geofence_breaches (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id),
  action VARCHAR(20) NOT NULL,     -- checkout_outside / checkin_outside
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  distance_meters INTEGER,
  occurred_at TIMESTAMP DEFAULT NOW(),
  alerted BOOLEAN DEFAULT false
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_staff_shift_assignments_staff_id ON staff_shift_assignments(staff_id);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_staff_id ON overtime_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_breaks_staff_id ON staff_breaks(staff_id);
CREATE INDEX IF NOT EXISTS idx_attendance_disputes_staff_id ON attendance_disputes(staff_id);
CREATE INDEX IF NOT EXISTS idx_geofence_breaches_staff_id ON geofence_breaches(staff_id);
