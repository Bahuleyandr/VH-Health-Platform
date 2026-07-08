-- 444_migration_toolkit_hl7_adt_batches.sql
-- NL11-S9 P2: HL7 ADT migration batch intake with no raw-message persistence.

CREATE TABLE IF NOT EXISTS migration_hl7_adt_batches (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL DEFAULT 'received',
  source_filename VARCHAR(260),
  content_sha256 VARCHAR(64) NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(160) NOT NULL,
  received_by UUID,
  completed_at TIMESTAMPTZ(6),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_hl7_adt_batches_uid_unique UNIQUE (uid),
  CONSTRAINT migration_hl7_adt_batches_status_check
    CHECK (status IN ('received', 'processing', 'committed', 'failed', 'rolled_back')),
  CONSTRAINT migration_hl7_adt_batches_hash_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT migration_hl7_adt_batches_counts_check
    CHECK (message_count >= 0 AND accepted_count >= 0 AND rejected_count >= 0),
  CONSTRAINT ux_migration_hl7_adt_batches_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_migration_hl7_adt_batches_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_hl7_adt_batches_job
  ON migration_hl7_adt_batches (tenant_id, job_id, created_at DESC);

ALTER TABLE migration_hl7_adt_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_hl7_adt_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_hl7_adt_batches;
CREATE POLICY tenant_isolation ON migration_hl7_adt_batches
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

CREATE TABLE IF NOT EXISTS migration_hl7_adt_messages (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  hl7_batch_id BIGINT NOT NULL REFERENCES migration_hl7_adt_batches(id) ON DELETE CASCADE,
  commit_batch_id BIGINT REFERENCES migration_commit_batches(id) ON DELETE SET NULL,
  message_control_id VARCHAR(120) NOT NULL,
  message_type VARCHAR(20) NOT NULL,
  source_patient_key VARCHAR(180),
  raw_message_hash VARCHAR(64) NOT NULL,
  parsed_summary_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'parsed',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_hl7_adt_messages_uid_unique UNIQUE (uid),
  CONSTRAINT migration_hl7_adt_messages_type_check
    CHECK (message_type IN ('ADT^A01', 'ADT^A02', 'ADT^A03')),
  CONSTRAINT migration_hl7_adt_messages_status_check
    CHECK (status IN ('parsed', 'committed', 'rejected', 'rolled_back')),
  CONSTRAINT migration_hl7_adt_messages_hash_check
    CHECK (raw_message_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ux_migration_hl7_adt_messages_control
    UNIQUE (tenant_id, hl7_batch_id, message_control_id),
  CONSTRAINT fk_migration_hl7_adt_messages_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_hl7_adt_messages_batch
  ON migration_hl7_adt_messages (tenant_id, hl7_batch_id, status);

CREATE INDEX IF NOT EXISTS idx_migration_hl7_adt_messages_patient
  ON migration_hl7_adt_messages (tenant_id, source_patient_key)
  WHERE source_patient_key IS NOT NULL;

ALTER TABLE migration_hl7_adt_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_hl7_adt_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_hl7_adt_messages;
CREATE POLICY tenant_isolation ON migration_hl7_adt_messages
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
