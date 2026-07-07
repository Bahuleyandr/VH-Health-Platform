-- NL-7 P1: tenant-scoped device registry for bedside monitors/gateways.

CREATE TABLE IF NOT EXISTS device_registry (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  device_code VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  protocol VARCHAR(40) NOT NULL DEFAULT 'mllp-hl7v2',
  vendor VARCHAR(120),
  model VARCHAR(120),
  serial_number VARCHAR(120),
  biomed_device_id INTEGER REFERENCES clinical_ai_biomed_devices(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES facility_locations(id) ON DELETE SET NULL,
  allowed_source_ips INET[] NOT NULL DEFAULT '{}'::inet[],
  credential_hash VARCHAR(96),
  credential_prefix VARCHAR(32),
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT device_registry_kind_check CHECK (
    kind IN (
      'central_station',
      'monitor',
      'monitor_gateway',
      'fridge_sensor',
      'dialysis_machine',
      'rtls_feed',
      'other'
    )
  ),
  CONSTRAINT device_registry_protocol_check CHECK (protocol IN ('mllp-hl7v2', 'http-hl7v2', 'http-json')),
  CONSTRAINT device_registry_status_check CHECK (status IN ('active', 'paused', 'revoked', 'archived')),
  CONSTRAINT device_registry_code_not_blank CHECK (length(trim(device_code)) > 0),
  CONSTRAINT device_registry_name_not_blank CHECK (length(trim(display_name)) > 0)
);

ALTER TABLE device_registry
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_registry_tenant_code
  ON device_registry (tenant_id, device_code);

CREATE INDEX IF NOT EXISTS idx_device_registry_tenant_status
  ON device_registry (tenant_id, status, kind);

CREATE INDEX IF NOT EXISTS idx_device_registry_last_seen
  ON device_registry (tenant_id, last_seen_at)
  WHERE status = 'active';

ALTER TABLE device_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_registry_tenant_isolation ON device_registry;
DROP POLICY IF EXISTS tenant_isolation ON device_registry;
CREATE POLICY tenant_isolation ON device_registry
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
