-- Support tables for staff admin analytics/audit endpoints.

CREATE TABLE IF NOT EXISTS geofence_breaches (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  staff_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL DEFAULT 'outside_geofence',
  expected_latitude NUMERIC(10, 7),
  expected_longitude NUMERIC(10, 7),
  actual_latitude NUMERIC(10, 7),
  actual_longitude NUMERIC(10, 7),
  distance_meters NUMERIC(10, 2),
  location_text TEXT,
  device_info TEXT,
  alerted BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofence_breaches_staff_time
  ON geofence_breaches(staff_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_geofence_breaches_action
  ON geofence_breaches(action);

CREATE INDEX IF NOT EXISTS idx_geofence_breaches_alerted
  ON geofence_breaches(alerted);
