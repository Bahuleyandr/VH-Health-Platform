-- N6-13 CSSD instrument tracking: sterilization loads and set release state.

CREATE TABLE IF NOT EXISTS sterilization_loads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  load_code VARCHAR(80) NOT NULL,
  sterilizer_id VARCHAR(80),
  sterilizer_name VARCHAR(160),
  cycle_type VARCHAR(40) NOT NULL DEFAULT 'steam',
  cycle_number VARCHAR(80),
  status VARCHAR(40) NOT NULL DEFAULT 'planned',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  operator_uid UUID,
  released_by UUID,
  temperature_c NUMERIC(6,2),
  pressure_kpa NUMERIC(8,2),
  exposure_minutes INTEGER,
  drying_minutes INTEGER,
  biological_indicator_result VARCHAR(30) NOT NULL DEFAULT 'pending',
  chemical_indicator_result VARCHAR(30) NOT NULL DEFAULT 'pending',
  mechanical_indicator_result VARCHAR(30) NOT NULL DEFAULT 'pending',
  indicator_lot VARCHAR(120),
  set_ids BIGINT[] NOT NULL DEFAULT '{}'::bigint[],
  load_contents JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_reason TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT sterilization_loads_cycle_type_check
    CHECK (cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')),
  CONSTRAINT sterilization_loads_status_check
    CHECK (status IN ('planned', 'running', 'completed', 'passed', 'failed', 'cancelled')),
  CONSTRAINT sterilization_loads_bi_result_check
    CHECK (biological_indicator_result IN ('not_required', 'pending', 'passed', 'failed')),
  CONSTRAINT sterilization_loads_chemical_result_check
    CHECK (chemical_indicator_result IN ('not_required', 'pending', 'passed', 'failed')),
  CONSTRAINT sterilization_loads_mechanical_result_check
    CHECK (mechanical_indicator_result IN ('not_required', 'pending', 'passed', 'failed')),
  CONSTRAINT sterilization_loads_contents_array_check
    CHECK (jsonb_typeof(load_contents) = 'array'),
  CONSTRAINT sterilization_loads_exposure_check
    CHECK (exposure_minutes IS NULL OR exposure_minutes >= 0),
  CONSTRAINT sterilization_loads_drying_check
    CHECK (drying_minutes IS NULL OR drying_minutes >= 0),
  CONSTRAINT fk_sterilization_loads_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sterilization_loads_tenant_code
  ON sterilization_loads (tenant_id, UPPER(load_code));

CREATE INDEX IF NOT EXISTS idx_sterilization_loads_tenant_status
  ON sterilization_loads (tenant_id, status, COALESCE(completed_at, started_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_sterilization_loads_set_ids
  ON sterilization_loads USING GIN (set_ids);

ALTER TABLE instrument_sets
  ADD COLUMN IF NOT EXISTS current_sterilization_load_id BIGINT,
  ADD COLUMN IF NOT EXISTS last_passed_load_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_instrument_sets_current_sterilization_load'
  ) THEN
    ALTER TABLE instrument_sets
      ADD CONSTRAINT fk_instrument_sets_current_sterilization_load
      FOREIGN KEY (current_sterilization_load_id) REFERENCES sterilization_loads(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_instrument_sets_last_passed_load'
  ) THEN
    ALTER TABLE instrument_sets
      ADD CONSTRAINT fk_instrument_sets_last_passed_load
      FOREIGN KEY (last_passed_load_id) REFERENCES sterilization_loads(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_instrument_sets_current_load
  ON instrument_sets (tenant_id, current_sterilization_load_id)
  WHERE current_sterilization_load_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instrument_sets_last_passed_load
  ON instrument_sets (tenant_id, last_passed_load_id)
  WHERE last_passed_load_id IS NOT NULL;

ALTER TABLE sterilization_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE sterilization_loads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sterilization_loads;
CREATE POLICY tenant_isolation ON sterilization_loads
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
