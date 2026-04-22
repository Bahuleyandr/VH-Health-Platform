-- Staff roster optimizer — suggests shift assignments from historical
-- demand + per-staff preferences. Output is a suggested roster that a
-- manager reviews, edits, and publishes. Never auto-publishes.

CREATE TABLE IF NOT EXISTS staff_roster_runs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department VARCHAR(120) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  requested_by UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested', 'edited', 'published', 'discarded')),
  total_slots INTEGER NOT NULL DEFAULT 0,
  filled_slots INTEGER NOT NULL DEFAULT 0,
  coverage_gap_count INTEGER NOT NULL DEFAULT 0,
  preference_conflict_count INTEGER NOT NULL DEFAULT 0,
  suggestion JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  published_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_roster_runs_tenant_dept
  ON staff_roster_runs (tenant_id, department, start_date DESC);

CREATE TABLE IF NOT EXISTS staff_roster_preferences (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_uid UUID NOT NULL,
  preferred_shifts JSONB NOT NULL DEFAULT '[]'::jsonb,
  unavailable_dates DATE[] NOT NULL DEFAULT '{}',
  max_shifts_per_week INTEGER NOT NULL DEFAULT 5,
  min_rest_hours INTEGER NOT NULL DEFAULT 10,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, staff_uid)
);

INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, settings)
VALUES
  ('staff_roster_optimizer',
   'Staff Roster Optimizer',
   'Suggests shift assignments from historical demand + per-staff preferences. Manager reviews, edits, and publishes. Never auto-publishes; surfaces coverage gaps + preference conflicts.',
   false,
   '{"surface":"operations","risk":"low","status":"available","requiresClinicianSignoff":false,"reviewRoles":["ADMIN","HR_STAFF","DEPARTMENT_HEAD"],"outputSchema":{"type":"object","required":["assignments","coverage_gaps","preference_conflicts"]},"retentionDays":365}'::jsonb)
ON CONFLICT (module_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  settings = clinical_ai_modules.settings || EXCLUDED.settings,
  updated_at = NOW();
