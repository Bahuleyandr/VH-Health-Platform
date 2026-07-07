-- 425_migration_toolkit_mappings_records.sql
-- NL11-S1 P1: mapping profiles and redacted import-record previews.
-- Import records intentionally store redacted normalized previews for rehearsal
-- confidence; authoritative patient, encounter, and ledger rows are not written.

CREATE TABLE IF NOT EXISTS migration_mapping_profiles (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  profile_name VARCHAR(180) NOT NULL,
  source_system VARCHAR(120),
  target_kind VARCHAR(40) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  field_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  transform_notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_mapping_profiles_uid_unique UNIQUE (uid),
  CONSTRAINT migration_mapping_profiles_target_check
    CHECK (target_kind IN ('patient', 'encounter', 'opening_ar')),
  CONSTRAINT migration_mapping_profiles_status_check
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT migration_mapping_profiles_version_check CHECK (version > 0),
  CONSTRAINT ux_migration_mapping_profiles_name_version
    UNIQUE (tenant_id, target_kind, profile_name, version),
  CONSTRAINT fk_migration_mapping_profiles_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_mapping_profiles_tenant_target
  ON migration_mapping_profiles (tenant_id, target_kind, status, updated_at DESC);

ALTER TABLE migration_mapping_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_mapping_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_mapping_profiles;
CREATE POLICY tenant_isolation ON migration_mapping_profiles
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

CREATE TABLE IF NOT EXISTS migration_import_records (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  source_file_id BIGINT NOT NULL REFERENCES migration_source_files(id) ON DELETE CASCADE,
  mapping_profile_id BIGINT REFERENCES migration_mapping_profiles(id) ON DELETE SET NULL,
  target_kind VARCHAR(40) NOT NULL,
  source_row_number INTEGER NOT NULL,
  source_key VARCHAR(180),
  row_hash VARCHAR(64) NOT NULL,
  normalized_preview_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_state VARCHAR(30) NOT NULL DEFAULT 'pending',
  duplicate_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_import_records_uid_unique UNIQUE (uid),
  CONSTRAINT migration_import_records_target_check
    CHECK (target_kind IN ('patient', 'encounter', 'opening_ar')),
  CONSTRAINT migration_import_records_state_check
    CHECK (validation_state IN ('pending', 'valid', 'warning', 'error')),
  CONSTRAINT migration_import_records_row_number_check CHECK (source_row_number > 0),
  CONSTRAINT migration_import_records_hash_check
    CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ux_migration_import_records_source_row
    UNIQUE (tenant_id, source_file_id, source_row_number),
  CONSTRAINT fk_migration_import_records_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_import_records_job_state
  ON migration_import_records (tenant_id, job_id, validation_state, source_row_number);

CREATE INDEX IF NOT EXISTS idx_migration_import_records_duplicate
  ON migration_import_records (tenant_id, job_id, duplicate_candidate)
  WHERE duplicate_candidate IS TRUE;

ALTER TABLE migration_import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_import_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_import_records;
CREATE POLICY tenant_isolation ON migration_import_records
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
