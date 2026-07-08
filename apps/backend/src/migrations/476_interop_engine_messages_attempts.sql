-- 476_interop_engine_messages_attempts.sql
--
-- NL11-S11 Interface Engine P1: PHI-bearing message store plus append-only
-- processing/delivery attempts.

BEGIN;

CREATE TABLE IF NOT EXISTS interop_messages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  channel_id INTEGER NOT NULL REFERENCES interop_channels(id) ON DELETE CASCADE,
  channel_version_id INTEGER NOT NULL REFERENCES interop_channel_versions(id) ON DELETE RESTRICT,
  direction VARCHAR(20) NOT NULL,
  protocol VARCHAR(30) NOT NULL,
  message_type VARCHAR(80),
  external_control_id VARCHAR(160),
  dedupe_key VARCHAR(240),
  payload_hash VARCHAR(64) NOT NULL,
  raw_payload_ciphertext TEXT,
  raw_payload_retained BOOLEAN NOT NULL DEFAULT true,
  redacted_preview TEXT,
  parsed_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  patient_uid UUID,
  source_table VARCHAR(80),
  source_id VARCHAR(80),
  status VARCHAR(30) NOT NULL DEFAULT 'received',
  last_error_code VARCHAR(80),
  last_error_safe TEXT,
  retention_until TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_messages_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_messages_direction
    CHECK (direction IN ('inbound', 'outbound', 'bidirectional')),
  CONSTRAINT chk_interop_messages_protocol
    CHECK (protocol IN ('hl7v2', 'csv', 'json', 'fhir_json', 'other')),
  CONSTRAINT chk_interop_messages_status
    CHECK (status IN (
      'received', 'parsed', 'validated', 'transformed', 'queued', 'delivering',
      'delivered', 'failed', 'dead', 'quarantined', 'replay_requested',
      'replayed', 'ignored_duplicate'
    )),
  CONSTRAINT chk_interop_messages_raw_retention
    CHECK (raw_payload_retained = true OR raw_payload_ciphertext IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_interop_messages_dedupe
  ON interop_messages (tenant_id, channel_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interop_messages_channel_status
  ON interop_messages (tenant_id, channel_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interop_messages_due_outbound
  ON interop_messages (tenant_id, status, updated_at)
  WHERE direction IN ('outbound', 'bidirectional')
    AND status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_interop_messages_payload_hash
  ON interop_messages (tenant_id, payload_hash);

CREATE TABLE IF NOT EXISTS interop_message_attempts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  message_id INTEGER NOT NULL REFERENCES interop_messages(id) ON DELETE CASCADE,
  channel_version_id INTEGER NOT NULL REFERENCES interop_channel_versions(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  phase VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ(6),
  duration_ms INTEGER,
  request_id VARCHAR(120),
  backend_idempotency_key VARCHAR(240),
  response_status INTEGER,
  safe_error TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_interop_message_attempts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_interop_message_attempts_phase
    CHECK (phase IN ('receive', 'parse', 'validate', 'transform', 'deliver_backend', 'deliver_external', 'ack', 'replay')),
  CONSTRAINT chk_interop_message_attempts_status
    CHECK (status IN ('ok', 'failed', 'dead', 'skipped')),
  CONSTRAINT chk_interop_message_attempts_number
    CHECK (attempt_number > 0)
);

CREATE INDEX IF NOT EXISTS idx_interop_message_attempts_message
  ON interop_message_attempts (tenant_id, message_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_interop_message_attempts_phase_status
  ON interop_message_attempts (tenant_id, phase, status, created_at DESC);

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['interop_messages', 'interop_message_attempts'];
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
