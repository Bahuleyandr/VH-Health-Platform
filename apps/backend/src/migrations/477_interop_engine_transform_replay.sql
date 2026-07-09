-- 477_interop_engine_transform_replay.sql
--
-- NL11-S11 Interface Engine P1: transform fixture tests, replay batches, and
-- connector lease records for the held worker/data-plane.

BEGIN;

CREATE TABLE IF NOT EXISTS interop_transform_tests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  channel_version_id INTEGER NOT NULL REFERENCES interop_channel_versions(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  message_type VARCHAR(80),
  input_payload_ciphertext TEXT NOT NULL,
  input_payload_is_synthetic BOOLEAN NOT NULL DEFAULT true,
  expected_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_run_status VARCHAR(20),
  last_run_at TIMESTAMPTZ(6),
  last_run_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_transform_tests_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_transform_tests_status
    CHECK (last_run_status IS NULL OR last_run_status IN ('passed', 'failed', 'error')),
  CONSTRAINT ux_interop_transform_tests_name
    UNIQUE (tenant_id, channel_version_id, name)
);

CREATE INDEX IF NOT EXISTS idx_interop_transform_tests_version
  ON interop_transform_tests (tenant_id, channel_version_id, last_run_status);

CREATE TABLE IF NOT EXISTS interop_replay_batches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  channel_id INTEGER NOT NULL REFERENCES interop_channels(id) ON DELETE CASCADE,
  requested_by UUID,
  reason TEXT NOT NULL,
  selection_filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode VARCHAR(40) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'queued',
  message_count INTEGER NOT NULL DEFAULT 0,
  safe_summary TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),

  CONSTRAINT fk_interop_replay_batches_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_replay_batches_mode
    CHECK (mode IN ('retry_delivery', 'reprocess_original_version', 'reprocess_current_version', 'redeliver_external')),
  CONSTRAINT chk_interop_replay_batches_status
    CHECK (status IN ('queued', 'running', 'completed', 'completed_with_failures', 'cancelled')),
  CONSTRAINT chk_interop_replay_batches_reason
    CHECK (length(btrim(reason)) >= 8)
);

CREATE INDEX IF NOT EXISTS idx_interop_replay_batches_channel
  ON interop_replay_batches (tenant_id, channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interop_worker_leases (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  lease_key VARCHAR(180) NOT NULL,
  channel_id INTEGER REFERENCES interop_channels(id) ON DELETE CASCADE,
  owner_id VARCHAR(160) NOT NULL,
  heartbeat_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_worker_leases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT ux_interop_worker_leases_key
    UNIQUE (tenant_id, lease_key)
);

CREATE INDEX IF NOT EXISTS idx_interop_worker_leases_expires
  ON interop_worker_leases (tenant_id, expires_at);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['interop_transform_tests', 'interop_replay_batches', 'interop_worker_leases'];
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
