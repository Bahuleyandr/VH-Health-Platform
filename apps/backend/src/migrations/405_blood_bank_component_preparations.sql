-- NL-6 N6-3 BB-B: donor-linked unit genealogy and component preparation.

BEGIN;

ALTER TABLE blood_units
  ADD COLUMN IF NOT EXISTS donor_id INTEGER,
  ADD COLUMN IF NOT EXISTS donation_event_id INTEGER,
  ADD COLUMN IF NOT EXISTS parent_unit_id INTEGER,
  ADD COLUMN IF NOT EXISTS component_preparation_id INTEGER,
  ADD COLUMN IF NOT EXISTS component_sequence INTEGER,
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS prepared_by UUID,
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
  ADD COLUMN IF NOT EXISTS discard_confirmed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS discard_confirmed_by UUID;

ALTER TABLE blood_units
  DROP CONSTRAINT IF EXISTS chk_blood_units_status;
ALTER TABLE blood_units
  ADD CONSTRAINT chk_blood_units_status
    CHECK (status IN ('available', 'reserved', 'crossmatched', 'issued', 'transfused',
                      'discarded', 'expired', 'returned', 'quarantined', 'separated'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blood_units_donor') THEN
    ALTER TABLE blood_units
      ADD CONSTRAINT fk_blood_units_donor
        FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blood_units_donation_event') THEN
    ALTER TABLE blood_units
      ADD CONSTRAINT fk_blood_units_donation_event
        FOREIGN KEY (donation_event_id) REFERENCES donation_events(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blood_units_parent_unit') THEN
    ALTER TABLE blood_units
      ADD CONSTRAINT fk_blood_units_parent_unit
        FOREIGN KEY (parent_unit_id) REFERENCES blood_units(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS component_preparations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donation_event_id INTEGER NOT NULL,
  donor_id INTEGER NOT NULL,
  parent_unit_id INTEGER,
  preparation_code VARCHAR(80) NOT NULL,
  method VARCHAR(40) NOT NULL DEFAULT 'manual',
  prepared_units JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'prepared',
  prepared_by UUID,
  prepared_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_component_preparations_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_component_preparations_donation_event
    FOREIGN KEY (donation_event_id) REFERENCES donation_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_component_preparations_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT fk_component_preparations_parent_unit
    FOREIGN KEY (parent_unit_id) REFERENCES blood_units(id) ON DELETE SET NULL,
  CONSTRAINT ux_component_preparations_code UNIQUE (tenant_id, preparation_code),
  CONSTRAINT chk_component_preparations_status
    CHECK (status IN ('prepared', 'cancelled')),
  CONSTRAINT chk_component_preparations_method
    CHECK (method IN ('manual', 'automated', 'apheresis'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blood_units_component_preparation') THEN
    ALTER TABLE blood_units
      ADD CONSTRAINT fk_blood_units_component_preparation
        FOREIGN KEY (component_preparation_id) REFERENCES component_preparations(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_blood_units_donor_trace
  ON blood_units (tenant_id, donor_id, donation_event_id, parent_unit_id);

CREATE INDEX IF NOT EXISTS idx_blood_units_preparation
  ON blood_units (tenant_id, component_preparation_id, component_sequence);

CREATE INDEX IF NOT EXISTS idx_blood_units_quarantine
  ON blood_units (tenant_id, status, quarantined_at DESC)
  WHERE status = 'quarantined';

CREATE INDEX IF NOT EXISTS idx_component_preparations_donation
  ON component_preparations (tenant_id, donation_event_id, prepared_at DESC);

ALTER TABLE component_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_preparations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON component_preparations;
CREATE POLICY tenant_isolation ON component_preparations
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
