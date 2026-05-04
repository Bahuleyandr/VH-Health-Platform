-- Staff operational workflow tables for attendance disputes, breaks,
-- overtime, and housekeeping. These routes existed before the backing
-- tables were ported into the canonical migration stream.

CREATE TABLE IF NOT EXISTS staff_breaks (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER REFERENCES staff_attendance(id) ON DELETE SET NULL,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  break_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  break_end TIMESTAMPTZ,
  duration_minutes NUMERIC(8,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_breaks_staff ON staff_breaks(staff_id, break_start);
CREATE INDEX IF NOT EXISTS idx_staff_breaks_staff_uid ON staff_breaks(staff_uid);
CREATE INDEX IF NOT EXISTS idx_staff_breaks_open ON staff_breaks(staff_id) WHERE break_end IS NULL;

CREATE TABLE IF NOT EXISTS attendance_disputes (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  dispute_date DATE NOT NULL,
  dispute_type VARCHAR(40) NOT NULL,
  reason TEXT NOT NULL,
  requested_check_in TIMESTAMPTZ,
  requested_check_out TIMESTAMPTZ,
  evidence_url TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  resolution TEXT,
  reviewer_comment TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (staff_id, dispute_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_disputes_staff ON attendance_disputes(staff_id, dispute_date);
CREATE INDEX IF NOT EXISTS idx_attendance_disputes_staff_uid ON attendance_disputes(staff_uid);
CREATE INDEX IF NOT EXISTS idx_attendance_disputes_status ON attendance_disputes(status);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  date DATE NOT NULL,
  extra_hours NUMERIC(5,2) NOT NULL,
  reason TEXT NOT NULL,
  type VARCHAR(30) DEFAULT 'comp_time',
  status VARCHAR(20) DEFAULT 'pending',
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_staff ON overtime_requests(staff_id, date);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_staff_uid ON overtime_requests(staff_uid);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_status ON overtime_requests(status);

CREATE SEQUENCE IF NOT EXISTS housekeeping_log_number_seq;
CREATE SEQUENCE IF NOT EXISTS housekeeping_request_number_seq;

CREATE TABLE IF NOT EXISTS housekeeping_zones (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  zone_type VARCHAR(60) NOT NULL DEFAULT 'general',
  floor VARCHAR(80),
  building VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_housekeeping_zones_name_type
  ON housekeeping_zones(LOWER(name), LOWER(zone_type));
CREATE INDEX IF NOT EXISTS idx_housekeeping_zones_active ON housekeeping_zones(is_active, zone_type);

CREATE TABLE IF NOT EXISTS housekeeping_logs (
  id SERIAL PRIMARY KEY,
  log_number VARCHAR(40) UNIQUE NOT NULL DEFAULT (
    'HKL-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('housekeeping_log_number_seq')::TEXT, 6, '0')
  ),
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  zone_id INTEGER REFERENCES housekeeping_zones(id) ON DELETE SET NULL,
  location_text TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  cleaning_type VARCHAR(40) NOT NULL DEFAULT 'routine',
  notes TEXT,
  photo_key TEXT,
  photo_url TEXT,
  signature_hash VARCHAR(64),
  status VARCHAR(20) DEFAULT 'submitted',
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_by_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  flag_reason TEXT,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_housekeeping_logs_staff ON housekeeping_logs(staff_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_housekeeping_logs_zone ON housekeeping_logs(zone_id);
CREATE INDEX IF NOT EXISTS idx_housekeeping_logs_status ON housekeeping_logs(status);

CREATE TABLE IF NOT EXISTS housekeeping_requests (
  id SERIAL PRIMARY KEY,
  request_number VARCHAR(40) UNIQUE NOT NULL DEFAULT (
    'HKR-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('housekeeping_request_number_seq')::TEXT, 6, '0')
  ),
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  zone_id INTEGER REFERENCES housekeeping_zones(id) ON DELETE SET NULL,
  location_text TEXT NOT NULL DEFAULT '',
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  request_type VARCHAR(40) NOT NULL DEFAULT 'cleaning',
  urgency VARCHAR(20) DEFAULT 'normal',
  description TEXT,
  photo_key TEXT,
  photo_url TEXT,
  status VARCHAR(20) DEFAULT 'open',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_by_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  completion_notes TEXT,
  completion_photo_key TEXT,
  completion_photo_url TEXT,
  completion_signature_hash VARCHAR(64),
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_by_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  sla_due_at TIMESTAMPTZ,
  sla_breached BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_housekeeping_requests_requester ON housekeeping_requests(requester_id, created_at);
CREATE INDEX IF NOT EXISTS idx_housekeeping_requests_assigned ON housekeeping_requests(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_housekeeping_requests_status ON housekeeping_requests(status, urgency);

CREATE TABLE IF NOT EXISTS housekeeping_request_updates (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES housekeeping_requests(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  author_role VARCHAR(60) NOT NULL,
  message TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_housekeeping_request_updates_request ON housekeeping_request_updates(request_id, created_at);
