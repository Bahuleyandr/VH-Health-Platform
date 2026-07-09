-- 475_interop_engine_systems_channels.sql
--
-- NL11-S11 Interface Engine P1: tenant-scoped external systems, channels,
-- and immutable channel versions. Raw PHI payloads land in migration 476.

BEGIN;

CREATE TABLE IF NOT EXISTS interop_systems (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  system_key VARCHAR(80) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  direction VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  allowed_source_ips TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_systems_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_systems_kind
    CHECK (kind IN ('his', 'lis', 'ris', 'pacs', 'billing', 'hie', 'migration_source', 'vh_backend', 'other')),
  CONSTRAINT chk_interop_systems_direction
    CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  CONSTRAINT chk_interop_systems_status
    CHECK (status IN ('draft', 'active', 'paused', 'revoked')),
  CONSTRAINT ux_interop_systems_key
    UNIQUE (tenant_id, system_key)
);

CREATE TABLE IF NOT EXISTS interop_channels (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  channel_key VARCHAR(100) NOT NULL,
  display_name VARCHAR(180) NOT NULL,
  source_system_id INTEGER REFERENCES interop_systems(id) ON DELETE SET NULL,
  target_system_id INTEGER REFERENCES interop_systems(id) ON DELETE SET NULL,
  direction VARCHAR(20) NOT NULL,
  connector_kind VARCHAR(40) NOT NULL,
  protocol VARCHAR(30) NOT NULL,
  message_types TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  active_version_id INTEGER,
  auth_kind VARCHAR(40) NOT NULL DEFAULT 'tenant_interop_secret',
  auth_sender_identifier VARCHAR(255),
  retention_days INTEGER NOT NULL DEFAULT 30,
  max_attempts INTEGER NOT NULL DEFAULT 7,
  retry_policy JSONB NOT NULL DEFAULT '{"backoff":"exponential","maxDelayMinutes":60}'::jsonb,
  dead_letter_policy JSONB NOT NULL DEFAULT '{"onMaxAttempts":"dead"}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_channels_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_channels_direction
    CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  CONSTRAINT chk_interop_channels_connector
    CHECK (connector_kind IN ('http_inbound', 'mllp_listener', 'http_outbound', 'file_sftp_poll', 'manual_upload', 'internal_backend')),
  CONSTRAINT chk_interop_channels_protocol
    CHECK (protocol IN ('hl7v2', 'csv', 'json', 'fhir_json', 'other')),
  CONSTRAINT chk_interop_channels_status
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  CONSTRAINT chk_interop_channels_auth
    CHECK (auth_kind IN ('tenant_interop_secret', 'internal', 'none')),
  CONSTRAINT chk_interop_channels_retention
    CHECK (retention_days BETWEEN 1 AND 3650),
  CONSTRAINT chk_interop_channels_attempts
    CHECK (max_attempts BETWEEN 1 AND 25),
  CONSTRAINT ux_interop_channels_key
    UNIQUE (tenant_id, channel_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_interop_channels_auth_sender
  ON interop_channels (auth_kind, auth_sender_identifier)
  WHERE auth_kind = 'tenant_interop_secret'
    AND auth_sender_identifier IS NOT NULL
    AND status <> 'archived';

CREATE TABLE IF NOT EXISTS interop_channel_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  channel_id INTEGER NOT NULL REFERENCES interop_channels(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  connector_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  transform_dsl JSONB NOT NULL DEFAULT '{}'::jsonb,
  routing_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  activated_by UUID,
  activated_at TIMESTAMPTZ(6),
  retired_at TIMESTAMPTZ(6),
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_channel_versions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_channel_versions_status
    CHECK (status IN ('draft', 'candidate', 'active', 'retired')),
  CONSTRAINT chk_interop_channel_versions_number
    CHECK (version_number > 0),
  CONSTRAINT ux_interop_channel_versions_number
    UNIQUE (tenant_id, channel_id, version_number)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interop_channels_active_version') THEN
    ALTER TABLE interop_channels
      ADD CONSTRAINT fk_interop_channels_active_version
      FOREIGN KEY (active_version_id) REFERENCES interop_channel_versions(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_interop_systems_tenant_status
  ON interop_systems (tenant_id, status, kind);
CREATE INDEX IF NOT EXISTS idx_interop_channels_tenant_status
  ON interop_channels (tenant_id, status, connector_kind);
CREATE INDEX IF NOT EXISTS idx_interop_channel_versions_channel
  ON interop_channel_versions (tenant_id, channel_id, status);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['interop_systems', 'interop_channels', 'interop_channel_versions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $f$, t);
  END LOOP;
END
$$;

COMMIT;
