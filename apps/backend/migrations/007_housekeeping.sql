-- Housekeeping zones/locations (predefined for the hospital)
CREATE TABLE IF NOT EXISTS housekeeping_zones (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,           -- e.g. "Ward 3 - Corridor", "OT - Pre-op Area"
  floor VARCHAR(50),
  building VARCHAR(100),
  zone_type VARCHAR(50) DEFAULT 'general',  -- general | icu | ot | ward | toilet | common
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cleaning completion logs (proof of work)
CREATE TABLE IF NOT EXISTS housekeeping_logs (
  id SERIAL PRIMARY KEY,
  log_number VARCHAR(30) UNIQUE NOT NULL,  -- HK-2026-0001
  staff_id INTEGER REFERENCES users(id),
  zone_id INTEGER REFERENCES housekeeping_zones(id),
  location_text VARCHAR(300),             -- free-text if zone not in list
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  cleaning_type VARCHAR(50) DEFAULT 'routine',  -- routine | deep | disinfection | spillage | post_procedure
  notes TEXT,
  -- Photo evidence
  photo_key TEXT,                         -- R2 file key
  photo_url TEXT,                         -- signed URL (short-lived, regenerated on demand)
  -- Tamper-evident signature
  signature_hash VARCHAR(64),             -- SHA-256 of (staff_id + zone_id + timestamp + photo_key)
  -- Status
  status VARCHAR(20) DEFAULT 'submitted', -- submitted | verified | flagged
  verified_by INTEGER REFERENCES users(id),
  verified_at TIMESTAMP,
  flag_reason TEXT,
  -- Meta
  logged_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS hk_log_number_seq START 1;
CREATE OR REPLACE FUNCTION generate_hk_log_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.log_number := 'HK-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('hk_log_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS hk_log_number_trigger ON housekeeping_logs;
CREATE TRIGGER hk_log_number_trigger
  BEFORE INSERT ON housekeeping_logs
  FOR EACH ROW EXECUTE FUNCTION generate_hk_log_number();

-- Housekeeping requests (raised by any staff / patient-facing staff)
CREATE TABLE IF NOT EXISTS housekeeping_requests (
  id SERIAL PRIMARY KEY,
  request_number VARCHAR(30) UNIQUE NOT NULL,  -- HKR-2026-0001
  requester_id INTEGER REFERENCES users(id),
  zone_id INTEGER REFERENCES housekeeping_zones(id),
  location_text VARCHAR(300) NOT NULL,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  request_type VARCHAR(50) DEFAULT 'cleaning',  -- cleaning | spillage | waste | linen | disinfection | other
  urgency VARCHAR(20) DEFAULT 'normal',         -- low | normal | high | urgent
  description TEXT,
  photo_key TEXT,                               -- photo of the problem
  photo_url TEXT,
  -- Assignment
  status VARCHAR(30) DEFAULT 'open',
  -- open | assigned | in_progress | completed | verified | closed | cancelled
  assigned_to INTEGER REFERENCES users(id),
  assigned_at TIMESTAMP,
  assigned_by INTEGER REFERENCES users(id),
  -- Completion
  completed_at TIMESTAMP,
  completion_notes TEXT,
  completion_photo_key TEXT,
  completion_photo_url TEXT,
  completion_signature_hash VARCHAR(64),
  -- Verification
  verified_by INTEGER REFERENCES users(id),
  verified_at TIMESTAMP,
  -- SLA
  sla_due_at TIMESTAMP,  -- auto-set: urgent=30min, high=2h, normal=4h, low=24h
  sla_breached BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS hk_req_number_seq START 1;
CREATE OR REPLACE FUNCTION generate_hk_req_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.request_number := 'HKR-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('hk_req_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS hk_req_number_trigger ON housekeeping_requests;
CREATE TRIGGER hk_req_number_trigger
  BEFORE INSERT ON housekeeping_requests
  FOR EACH ROW EXECUTE FUNCTION generate_hk_req_number();

-- Request status updates / comments
CREATE TABLE IF NOT EXISTS housekeeping_request_updates (
  id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES housekeeping_requests(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  author_role VARCHAR(50),     -- staff | hk_staff | supervisor | admin | system
  message TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Pre-seed default zones (update these for actual hospital layout)
INSERT INTO housekeeping_zones (name, floor, zone_type) VALUES
  ('General Ward - Corridor',     'Ground', 'ward'),
  ('General Ward - Patient Rooms','Ground', 'ward'),
  ('ICU',                         'First',  'icu'),
  ('OT - Pre-op Area',            'First',  'ot'),
  ('OT - Post-op Area',           'First',  'ot'),
  ('OPD Waiting Area',            'Ground', 'common'),
  ('Emergency Department',        'Ground', 'general'),
  ('Pharmacy',                    'Ground', 'general'),
  ('Radiology / Imaging',         'Ground', 'general'),
  ('Staff Canteen',               'Ground', 'common'),
  ('Male Washroom - Ground Floor','Ground', 'toilet'),
  ('Female Washroom - Ground Floor','Ground','toilet'),
  ('Stairwell - Block A',         'All',    'common'),
  ('Reception / Lobby',           'Ground', 'common')
ON CONFLICT DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hk_logs_staff   ON housekeeping_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_hk_logs_zone    ON housekeeping_logs(zone_id);
CREATE INDEX IF NOT EXISTS idx_hk_logs_ts      ON housekeeping_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_hk_req_status   ON housekeeping_requests(status);
CREATE INDEX IF NOT EXISTS idx_hk_req_assigned ON housekeeping_requests(assigned_to);
CREATE INDEX IF NOT EXISTS idx_hk_req_ts       ON housekeeping_requests(created_at DESC);
