-- NL-7 P2: cold-chain monitored units and append-only readings.
-- Retention is kept per unit (minimum 730 days) and readings carry a BRIN
-- index so high-frequency temperature samples stay cheap to audit/export.

CREATE TABLE IF NOT EXISTS cold_chain_units (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE NO ACTION,
  unit_code VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  department VARCHAR(32) NOT NULL,
  location_id INTEGER REFERENCES facility_locations(id) ON DELETE SET NULL,
  biomed_device_id INTEGER REFERENCES clinical_ai_biomed_devices(id) ON DELETE SET NULL,
  device_registry_id INTEGER NOT NULL REFERENCES device_registry(id) ON DELETE RESTRICT,
  min_temp_c NUMERIC(5,2) NOT NULL,
  max_temp_c NUMERIC(5,2) NOT NULL,
  excursion_grace_minutes INTEGER NOT NULL DEFAULT 15,
  alert_roles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  retention_days INTEGER NOT NULL DEFAULT 730,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cold_chain_units_kind_check CHECK (kind IN ('fridge', 'freezer', 'ilr', 'ambient')),
  CONSTRAINT cold_chain_units_department_check CHECK (department IN ('pharmacy', 'blood_bank', 'lab', 'ward', 'ot')),
  CONSTRAINT cold_chain_units_status_check CHECK (status IN ('active', 'paused', 'retired')),
  CONSTRAINT cold_chain_units_temp_range_check CHECK (min_temp_c < max_temp_c),
  CONSTRAINT cold_chain_units_grace_check CHECK (excursion_grace_minutes BETWEEN 1 AND 240),
  CONSTRAINT cold_chain_units_retention_check CHECK (retention_days >= 730),
  CONSTRAINT cold_chain_units_code_not_blank CHECK (length(trim(unit_code)) > 0),
  CONSTRAINT cold_chain_units_name_not_blank CHECK (length(trim(display_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cold_chain_units_tenant_code
  ON cold_chain_units (tenant_id, unit_code);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cold_chain_units_tenant_device_active
  ON cold_chain_units (tenant_id, device_registry_id)
  WHERE status IN ('active', 'paused');

CREATE INDEX IF NOT EXISTS idx_cold_chain_units_tenant_status
  ON cold_chain_units (tenant_id, status, department);

CREATE TABLE IF NOT EXISTS cold_chain_readings (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE NO ACTION,
  unit_id INTEGER NOT NULL REFERENCES cold_chain_units(id) ON DELETE RESTRICT,
  device_registry_id INTEGER NOT NULL REFERENCES device_registry(id) ON DELETE RESTRICT,
  temp_c NUMERIC(5,2) NOT NULL,
  humidity_pct NUMERIC(5,2),
  battery_pct NUMERIC(5,2),
  recorded_at TIMESTAMPTZ(6) NOT NULL,
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cold_chain_readings_temp_check CHECK (temp_c BETWEEN -90 AND 80),
  CONSTRAINT cold_chain_readings_humidity_check CHECK (humidity_pct IS NULL OR humidity_pct BETWEEN 0 AND 100),
  CONSTRAINT cold_chain_readings_battery_check CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_cold_chain_readings_unit_recorded
  ON cold_chain_readings (tenant_id, unit_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_cold_chain_readings_device_recorded
  ON cold_chain_readings (tenant_id, device_registry_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS brin_cold_chain_readings_recorded
  ON cold_chain_readings USING BRIN (recorded_at);

ALTER TABLE cold_chain_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_chain_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cold_chain_units;
CREATE POLICY tenant_isolation ON cold_chain_units
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

ALTER TABLE cold_chain_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_chain_readings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cold_chain_readings;
CREATE POLICY tenant_isolation ON cold_chain_readings
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
