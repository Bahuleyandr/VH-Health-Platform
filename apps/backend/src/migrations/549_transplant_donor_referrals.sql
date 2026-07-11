-- NL-13 P6: transplant donor referrals.

CREATE TABLE IF NOT EXISTS transplant_donor_referrals (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  program_id BIGINT NOT NULL,
  donor_type VARCHAR(20) NOT NULL,
  source VARCHAR(160) NOT NULL,
  relation_category VARCHAR(80),
  screening_summary TEXT,
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'received',
  audit_register JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_donor_referrals_type_check
    CHECK (donor_type IN ('living', 'deceased')),
  CONSTRAINT transplant_donor_referrals_status_check
    CHECK (status IN ('received', 'screening', 'eligible', 'declined', 'withdrawn', 'matched', 'closed')),
  CONSTRAINT transplant_donor_referrals_docs_check
    CHECK (jsonb_typeof(documents) = 'array'),
  CONSTRAINT fk_transplant_donor_referrals_program
    FOREIGN KEY (program_id) REFERENCES transplant_programs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_transplant_donor_referrals_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_donor_referrals_program
  ON transplant_donor_referrals (tenant_id, program_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_donor_referrals_type
  ON transplant_donor_referrals (tenant_id, donor_type, status);

ALTER TABLE transplant_donor_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_donor_referrals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_donor_referrals;
CREATE POLICY tenant_isolation ON transplant_donor_referrals
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
