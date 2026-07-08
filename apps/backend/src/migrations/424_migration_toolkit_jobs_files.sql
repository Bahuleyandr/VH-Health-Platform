-- 424_migration_toolkit_jobs_files.sql
-- NL11-S1 P1: CSV-first migration rehearsal workspace.
-- This layer records import jobs and source-file profiles only. Raw CSV content
-- is not persisted by the backend; operators must re-submit source content for
-- each no-write rehearsal run.

CREATE TABLE IF NOT EXISTS migration_import_jobs (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_name VARCHAR(180) NOT NULL,
  source_system VARCHAR(120),
  import_kind VARCHAR(40) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  dry_run_only BOOLEAN NOT NULL DEFAULT TRUE,
  authoritative_write_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  redaction_mode VARCHAR(40) NOT NULL DEFAULT 'phi_redacted',
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_import_jobs_uid_unique UNIQUE (uid),
  CONSTRAINT migration_import_jobs_kind_check
    CHECK (import_kind IN ('patient', 'encounter', 'opening_ar', 'mixed')),
  CONSTRAINT migration_import_jobs_status_check
    CHECK (status IN ('draft', 'profiled', 'validated', 'report_ready', 'failed', 'archived')),
  CONSTRAINT migration_import_jobs_redaction_check
    CHECK (redaction_mode IN ('phi_redacted')),
  CONSTRAINT migration_import_jobs_no_write_check
    CHECK (dry_run_only IS TRUE AND authoritative_write_enabled IS FALSE),
  CONSTRAINT fk_migration_import_jobs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_import_jobs_tenant_status
  ON migration_import_jobs (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_migration_import_jobs_tenant_kind
  ON migration_import_jobs (tenant_id, import_kind, created_at DESC);

ALTER TABLE migration_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_import_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_import_jobs;
CREATE POLICY tenant_isolation ON migration_import_jobs
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

CREATE TABLE IF NOT EXISTS migration_source_files (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  file_kind VARCHAR(40) NOT NULL,
  source_filename VARCHAR(260) NOT NULL,
  content_sha256 VARCHAR(64) NOT NULL,
  mime_type VARCHAR(120) NOT NULL DEFAULT 'text/csv',
  byte_size INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  header_row JSONB NOT NULL DEFAULT '[]'::jsonb,
  column_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_rows_redacted JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_contract JSONB NOT NULL DEFAULT '{"raw_content_stored": false, "report_redaction": "phi_redacted"}'::jsonb,
  uploaded_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_source_files_uid_unique UNIQUE (uid),
  CONSTRAINT migration_source_files_kind_check
    CHECK (file_kind IN ('patient', 'encounter', 'opening_ar')),
  CONSTRAINT migration_source_files_hash_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fk_migration_source_files_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_source_files_job
  ON migration_source_files (tenant_id, job_id, file_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_migration_source_files_hash
  ON migration_source_files (tenant_id, content_sha256);

ALTER TABLE migration_source_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_source_files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_source_files;
CREATE POLICY tenant_isolation ON migration_source_files
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
