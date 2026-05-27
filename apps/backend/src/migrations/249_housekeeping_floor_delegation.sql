CREATE TABLE IF NOT EXISTS housekeeping_floor_assignments (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL,
  staff_uid UUID,
  zone_id INTEGER,
  zone_name VARCHAR(255),
  floor VARCHAR(80),
  building VARCHAR(120),
  shift_label VARCHAR(40) NOT NULL DEFAULT 'current',
  assigned_by INTEGER NOT NULL,
  assigned_by_uid UUID,
  reason TEXT,
  source_assignment_id INTEGER,
  is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_staff_active
  ON housekeeping_floor_assignments(staff_id, status, effective_to);

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_zone_active
  ON housekeeping_floor_assignments(zone_id, status, effective_to);

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_shift
  ON housekeeping_floor_assignments(shift_label, effective_from, effective_to);

CREATE INDEX IF NOT EXISTS idx_hk_floor_assignments_incharge
  ON housekeeping_floor_assignments(assigned_by, created_at);
