-- NL-13 P6: transplant NOTTO export ledger.

CREATE TABLE IF NOT EXISTS transplant_notto_exports (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  program_id BIGINT NOT NULL,
  candidate_id BIGINT,
  package_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_reviewed_status VARCHAR(40) NOT NULL DEFAULT 'draft',
  owner_reviewed_by UUID,
  owner_reviewed_at TIMESTAMPTZ,
  upload_reference_id TEXT,
  audit_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  released_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_notto_exports_status_check
    CHECK (owner_reviewed_status IN ('draft', 'pending_owner_review', 'owner_reviewed', 'released', 'rejected')),
  CONSTRAINT transplant_notto_exports_release_evidence_check
    CHECK (
      owner_reviewed_status <> 'released'
      OR (
        owner_reviewed_by IS NOT NULL
        AND owner_reviewed_at IS NOT NULL
        AND released_at IS NOT NULL
        AND upload_reference_id IS NOT NULL
        AND audit_evidence <> '{}'::jsonb
      )
    ),
  CONSTRAINT fk_transplant_notto_exports_program
    FOREIGN KEY (program_id) REFERENCES transplant_programs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transplant_notto_exports_candidate
    FOREIGN KEY (candidate_id) REFERENCES transplant_candidates(id) ON DELETE SET NULL,
  CONSTRAINT fk_transplant_notto_exports_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_notto_exports_program
  ON transplant_notto_exports (tenant_id, program_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_notto_exports_status
  ON transplant_notto_exports (tenant_id, owner_reviewed_status, created_at DESC);

ALTER TABLE transplant_notto_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_notto_exports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_notto_exports;
CREATE POLICY tenant_isolation ON transplant_notto_exports
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
