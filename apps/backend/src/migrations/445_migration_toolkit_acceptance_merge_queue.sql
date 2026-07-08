-- 445_migration_toolkit_acceptance_merge_queue.sql
-- NL11-S9 P2: merge-review queue plus acceptance, rollback, and replay reports.

CREATE TABLE IF NOT EXISTS migration_merge_queue_items (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  commit_batch_id BIGINT NOT NULL REFERENCES migration_commit_batches(id) ON DELETE CASCADE,
  import_record_id BIGINT REFERENCES migration_import_records(id) ON DELETE SET NULL,
  conflict_kind VARCHAR(60) NOT NULL,
  source_patient_key VARCHAR(180),
  candidate_patient_uid UUID,
  imported_patient_uid UUID,
  status VARCHAR(40) NOT NULL DEFAULT 'review_required',
  review_payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT migration_merge_queue_items_uid_unique UNIQUE (uid),
  CONSTRAINT migration_merge_queue_items_conflict_check
    CHECK (conflict_kind IN (
      'phone_existing_patient',
      'identifier_existing_patient',
      'encounter_patient_unresolved',
      'opening_ar_patient_unresolved'
    )),
  CONSTRAINT migration_merge_queue_items_status_check
    CHECK (status IN ('review_required', 'accepted', 'merged', 'dismissed')),
  CONSTRAINT ux_migration_merge_queue_items_record
    UNIQUE (tenant_id, commit_batch_id, import_record_id, conflict_kind),
  CONSTRAINT fk_migration_merge_queue_items_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_merge_queue_items_job
  ON migration_merge_queue_items (tenant_id, job_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_migration_merge_queue_items_candidate
  ON migration_merge_queue_items (tenant_id, candidate_patient_uid)
  WHERE candidate_patient_uid IS NOT NULL;

ALTER TABLE migration_merge_queue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_merge_queue_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_merge_queue_items;
CREATE POLICY tenant_isolation ON migration_merge_queue_items
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

CREATE TABLE IF NOT EXISTS migration_acceptance_reports (
  id BIGSERIAL PRIMARY KEY,
  uid UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  job_id BIGINT NOT NULL REFERENCES migration_import_jobs(id) ON DELETE CASCADE,
  commit_batch_id BIGINT NOT NULL REFERENCES migration_commit_batches(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL DEFAULT 'accepted',
  phi_redacted BOOLEAN NOT NULL DEFAULT TRUE,
  report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  acceptance_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  opening_balance_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollback_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  replay_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT migration_acceptance_reports_uid_unique UNIQUE (uid),
  CONSTRAINT ux_migration_acceptance_reports_batch UNIQUE (commit_batch_id),
  CONSTRAINT migration_acceptance_reports_status_check
    CHECK (status IN ('accepted', 'accepted_with_conflicts', 'blocked')),
  CONSTRAINT migration_acceptance_reports_phi_redacted_check CHECK (phi_redacted IS TRUE),
  CONSTRAINT fk_migration_acceptance_reports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_migration_acceptance_reports_job
  ON migration_acceptance_reports (tenant_id, job_id, created_at DESC);

ALTER TABLE migration_acceptance_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_acceptance_reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_acceptance_reports;
CREATE POLICY tenant_isolation ON migration_acceptance_reports
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
