-- 443_migration_toolkit_commit_batches.sql
-- NL11-S9 P2: authoritative migration commit batches and row-level commit proofs.

ALTER TABLE migration_import_jobs
  DROP CONSTRAINT IF EXISTS migration_import_jobs_kind_check,
  ADD CONSTRAINT migration_import_jobs_kind_check
    CHECK (import_kind IN ('patient', 'encounter', 'opening_ar', 'mixed', 'hl7_adt'));

ALTER TABLE migration_import_jobs
  DROP CONSTRAINT IF EXISTS migration_import_jobs_status_check,
  ADD CONSTRAINT migration_import_jobs_status_check
    CHECK (status IN ('draft', 'profiled', 'validated', 'report_ready', 'committing', 'committed', 'rolled_back', 'failed', 'archived'));

ALTER TABLE migration_import_jobs
  DROP CONSTRAINT IF EXISTS migration_import_jobs_no_write_check,
  ADD CONSTRAINT migration_import_jobs_write_mode_check
    CHECK (
      (dry_run_only IS TRUE AND authoritative_write_enabled IS FALSE)
      OR (dry_run_only IS FALSE AND authoritative_write_enabled IS TRUE)
    );

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS migration_source_key VARCHAR(180);

CREATE UNIQUE INDEX IF NOT EXISTS ux_admissions_migration_source_key
  ON admissions (tenant_id, migration_source_key)
  WHERE migration_source_key IS NOT NULL;

ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS migration_source_key VARCHAR(180);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_migration_source_key
  ON billing_invoices (tenant_id, migration_source_key)
  WHERE migration_source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS migration_commit_batches (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL DEFAULT 'prepared',
  idempotency_key VARCHAR(160) NOT NULL,
  requested_by UUID,
  committed_by UUID,
  committed_at TIMESTAMPTZ(6),
  rolled_back_by UUID,
  rolled_back_at TIMESTAMPTZ(6),
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  acceptance_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  opening_balance_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollback_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  replay_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_commit_batches_uid_unique UNIQUE (uid),
  CONSTRAINT migration_commit_batches_status_check
    CHECK (status IN ('prepared', 'committing', 'committed', 'rolled_back', 'failed')),
  CONSTRAINT ux_migration_commit_batches_idempotency
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT fk_migration_commit_batches_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_commit_batches_job
  ON migration_commit_batches (tenant_id, job_id, created_at DESC);

ALTER TABLE migration_commit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_commit_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_commit_batches;
CREATE POLICY tenant_isolation ON migration_commit_batches
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

CREATE TABLE IF NOT EXISTS migration_commit_records (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  commit_batch_id BIGINT NOT NULL REFERENCES migration_commit_batches(id) ON DELETE CASCADE,
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  import_record_id BIGINT REFERENCES migration_import_records(id) ON DELETE SET NULL,
  target_kind VARCHAR(40) NOT NULL,
  source_key VARCHAR(180),
  row_hash VARCHAR(64),
  status VARCHAR(40) NOT NULL,
  action VARCHAR(40) NOT NULL,
  target_table VARCHAR(80),
  target_id VARCHAR(120),
  target_uid UUID,
  idempotency_key VARCHAR(220) NOT NULL,
  rollback_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  replay_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_redacted TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_commit_records_uid_unique UNIQUE (uid),
  CONSTRAINT migration_commit_records_target_check
    CHECK (target_kind IN ('patient', 'encounter', 'opening_ar')),
  CONSTRAINT migration_commit_records_status_check
    CHECK (status IN ('pending', 'committed', 'skipped', 'conflict', 'rolled_back', 'failed')),
  CONSTRAINT migration_commit_records_action_check
    CHECK (action IN ('created', 'reused', 'updated', 'queued_conflict', 'blocked', 'unsupported')),
  CONSTRAINT migration_commit_records_hash_check
    CHECK (row_hash IS NULL OR row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ux_migration_commit_records_idempotency
    UNIQUE (tenant_id, commit_batch_id, idempotency_key),
  CONSTRAINT fk_migration_commit_records_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_commit_records_batch
  ON migration_commit_records (tenant_id, commit_batch_id, target_kind, status);

CREATE INDEX IF NOT EXISTS idx_migration_commit_records_target
  ON migration_commit_records (tenant_id, target_table, target_id)
  WHERE target_table IS NOT NULL AND target_id IS NOT NULL;

ALTER TABLE migration_commit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_commit_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_commit_records;
CREATE POLICY tenant_isolation ON migration_commit_records
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
