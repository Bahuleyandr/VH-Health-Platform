-- N6-13 CSSD instrument tracking: set/tray registry.

CREATE TABLE IF NOT EXISTS instrument_sets (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  set_code VARCHAR(80) NOT NULL,
  barcode VARCHAR(80) NOT NULL,
  display_name VARCHAR(180) NOT NULL,
  set_type VARCHAR(40) NOT NULL DEFAULT 'instrument_set',
  specialty VARCHAR(80),
  storage_location VARCHAR(120),
  contents JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'available',
  usable BOOLEAN NOT NULL DEFAULT true,
  requires_reprocessing BOOLEAN NOT NULL DEFAULT false,
  last_issued_at TIMESTAMPTZ,
  last_returned_at TIMESTAMPTZ,
  last_sterilized_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  retired_by UUID,
  retirement_reason TEXT,
  label_printed_at TIMESTAMPTZ,
  label_printed_by UUID,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT instrument_sets_type_check
    CHECK (set_type IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other')),
  CONSTRAINT instrument_sets_status_check
    CHECK (status IN (
      'available',
      'issued',
      'in_theatre',
      'returned',
      'decontamination',
      'sterilization_pending',
      'sterilized',
      'unusable',
      'retired'
    )),
  CONSTRAINT instrument_sets_contents_array_check
    CHECK (jsonb_typeof(contents) = 'array'),
  CONSTRAINT fk_instrument_sets_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_instrument_sets_tenant_code
  ON instrument_sets (tenant_id, UPPER(set_code));

CREATE UNIQUE INDEX IF NOT EXISTS ux_instrument_sets_tenant_barcode
  ON instrument_sets (tenant_id, UPPER(barcode));

CREATE INDEX IF NOT EXISTS idx_instrument_sets_tenant_status
  ON instrument_sets (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_instrument_sets_tenant_usable
  ON instrument_sets (tenant_id, usable, requires_reprocessing, updated_at DESC);

ALTER TABLE instrument_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_sets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON instrument_sets;
CREATE POLICY tenant_isolation ON instrument_sets
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
