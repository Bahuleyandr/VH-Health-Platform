-- Migration 413: Mortuary cooler slot registry.
--
-- NL-6/N6-12 adds body storage capacity only. Death certification remains
-- migration 167's source of truth; this table tracks physical cooler slots and
-- their current occupancy.

BEGIN;

CREATE TABLE IF NOT EXISTS mortuary_slots (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  slot_code VARCHAR(80) NOT NULL,
  display_name VARCHAR(160),
  location_id INTEGER REFERENCES facility_locations(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'occupied', 'cleaning', 'maintenance', 'retired')),
  current_death_record_id INTEGER REFERENCES death_records(id) ON DELETE SET NULL,
  occupied_since TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_mortuary_slots_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT mortuary_slots_occupancy_consistency
    CHECK (
      (status = 'occupied' AND current_death_record_id IS NOT NULL AND occupied_since IS NOT NULL)
      OR
      (status <> 'occupied' AND current_death_record_id IS NULL AND occupied_since IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mortuary_slots_code
  ON mortuary_slots (tenant_id, slot_code);

CREATE INDEX IF NOT EXISTS idx_mortuary_slots_status
  ON mortuary_slots (tenant_id, status, slot_code);

CREATE INDEX IF NOT EXISTS idx_mortuary_slots_location
  ON mortuary_slots (tenant_id, location_id)
  WHERE location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mortuary_slots_current_body
  ON mortuary_slots (tenant_id, current_death_record_id)
  WHERE current_death_record_id IS NOT NULL;

ALTER TABLE mortuary_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mortuary_slots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mortuary_slots;
CREATE POLICY tenant_isolation ON mortuary_slots
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

COMMIT;
