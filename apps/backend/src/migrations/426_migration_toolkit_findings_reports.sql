-- 426_migration_toolkit_findings_reports.sql
-- NL11-S1 P1: validation findings and PHI-redacted rehearsal reports.

CREATE TABLE IF NOT EXISTS migration_validation_findings (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  source_file_id BIGINT NOT NULL REFERENCES migration_source_files(id) ON DELETE CASCADE,
  import_record_id BIGINT REFERENCES migration_import_records(id) ON DELETE CASCADE,
  finding_code VARCHAR(80) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  target_kind VARCHAR(40) NOT NULL,
  field_name VARCHAR(120),
  source_row_number INTEGER,
  message_redacted TEXT NOT NULL,
  remediation_hint TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_validation_findings_uid_unique UNIQUE (uid),
  CONSTRAINT migration_validation_findings_severity_check
    CHECK (severity IN ('info', 'warning', 'error')),
  CONSTRAINT migration_validation_findings_target_check
    CHECK (target_kind IN ('patient', 'encounter', 'opening_ar')),
  CONSTRAINT migration_validation_findings_row_check
    CHECK (source_row_number IS NULL OR source_row_number > 0),
  CONSTRAINT fk_migration_validation_findings_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_validation_findings_job
  ON migration_validation_findings (tenant_id, job_id, severity, finding_code);

CREATE INDEX IF NOT EXISTS idx_migration_validation_findings_record
  ON migration_validation_findings (tenant_id, import_record_id);

ALTER TABLE migration_validation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_validation_findings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_validation_findings;
CREATE POLICY tenant_isolation ON migration_validation_findings
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

CREATE TABLE IF NOT EXISTS migration_rehearsal_reports (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL DEFAULT 'report_ready',
  phi_redacted BOOLEAN NOT NULL DEFAULT TRUE,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  duplicate_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  no_write_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_rehearsal_reports_uid_unique UNIQUE (uid),
  CONSTRAINT ux_migration_rehearsal_reports_job UNIQUE (job_id),
  CONSTRAINT migration_rehearsal_reports_status_check
    CHECK (status IN ('report_ready', 'blocked')),
  CONSTRAINT migration_rehearsal_reports_phi_redacted_check CHECK (phi_redacted IS TRUE),
  CONSTRAINT fk_migration_rehearsal_reports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_rehearsal_reports_tenant
  ON migration_rehearsal_reports (tenant_id, created_at DESC);

ALTER TABLE migration_rehearsal_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_rehearsal_reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_rehearsal_reports;
CREATE POLICY tenant_isolation ON migration_rehearsal_reports
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
