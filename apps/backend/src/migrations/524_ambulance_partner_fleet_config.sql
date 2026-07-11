-- NL-14 P2/P3: ambulance partner/fleet policy seam.
-- Manual-first by default. Rows here describe an operator-reviewed partner or
-- internal fleet boundary; they do not enable ingestion by themselves.

CREATE TABLE IF NOT EXISTS ambulance_partner_fleet_configs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  partner_code VARCHAR(80) NOT NULL,
  partner_name VARCHAR(255) NOT NULL,
  fleet_scope VARCHAR(40) NOT NULL DEFAULT 'manual_first',
  integration_mode VARCHAR(40) NOT NULL DEFAULT 'manual_only',
  status VARCHAR(24) NOT NULL DEFAULT 'inert',
  consent_boundary JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_owner_uid UUID,
  evidence_owner_role VARCHAR(80),
  evidence_source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_uid UUID,
  reviewer_role VARCHAR(80),
  reviewed_at TIMESTAMPTZ,
  reviewer_signoff_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ambulance_partner_fleet_configs_scope_chk CHECK (
    fleet_scope IN ('manual_first', 'internal_fleet', 'named_partner', 'api_device')
  ),
  CONSTRAINT ambulance_partner_fleet_configs_integration_mode_chk CHECK (
    integration_mode IN ('manual_only', 'api_device', 'device_link')
  ),
  CONSTRAINT ambulance_partner_fleet_configs_status_chk CHECK (
    status IN ('inert', 'draft', 'active', 'suspended', 'retired')
  ),
  CONSTRAINT ambulance_partner_fleet_configs_effective_chk CHECK (
    effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT fk_ambulance_partner_fleet_configs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ambulance_partner_config_code
  ON ambulance_partner_fleet_configs (tenant_id, partner_code);

CREATE INDEX IF NOT EXISTS idx_ambulance_partner_config_status
  ON ambulance_partner_fleet_configs (tenant_id, status, updated_at DESC);

ALTER TABLE ambulance_partner_fleet_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambulance_partner_fleet_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ambulance_partner_fleet_configs;
CREATE POLICY tenant_isolation ON ambulance_partner_fleet_configs
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
