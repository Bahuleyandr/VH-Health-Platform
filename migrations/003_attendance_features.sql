-- Attendance regularization requests
CREATE TABLE IF NOT EXISTS attendance_regularization (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id),
  date DATE NOT NULL,
  reason TEXT NOT NULL,
  requested_check_in TIMESTAMP,
  requested_check_out TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by INTEGER,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(staff_id, date)
);

-- Replacement requests
CREATE TABLE IF NOT EXISTS replacement_requests (
  id SERIAL PRIMARY KEY,
  leave_request_id INTEGER,
  requester_id INTEGER REFERENCES users(id),
  replacement_staff_id INTEGER REFERENCES users(id),
  dates TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  requester_message TEXT,
  responder_message TEXT,
  requested_at TIMESTAMP DEFAULT NOW(),
  responded_at TIMESTAMP,
  hr_approved_at TIMESTAMP,
  hr_approved_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_replacement_replacement_staff ON replacement_requests(replacement_staff_id);
CREATE INDEX IF NOT EXISTS idx_replacement_requester ON replacement_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_regularization_staff ON attendance_regularization(staff_id);
