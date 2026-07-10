-- NL-14 P2: tenant ED policy and canonical triage scale.
-- The table is inert by default. Active ED triage writes must find one
-- reviewed tenant policy with exactly one canonical scale selected.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_ed_policies (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  canonical_triage_scale VARCHAR(24),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  alternative_scale_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  trauma_registry_participation VARCHAR(32),
  registry_export_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_owner_uid UUID,
  clinical_governance_owner_uid UUID,
  reviewer_uid UUID,
  reviewed_at TIMESTAMPTZ(6),
  activated_by UUID,
  activated_at TIMESTAMPTZ(6),
  policy_version VARCHAR(80),
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_ed_policies_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tenant_ed_policies_scale_check CHECK (
    canonical_triage_scale IS NULL
    OR canonical_triage_scale IN ('esi', 'ats', 'ctas', 'manchester')
  ),
  CONSTRAINT tenant_ed_policies_registry_check CHECK (
    trauma_registry_participation IS NULL
    OR trauma_registry_participation IN ('internal_only', 'state_partner', 'registry_ready')
  ),
  CONSTRAINT tenant_ed_policies_active_requires_review CHECK (
    active = FALSE
    OR (
      canonical_triage_scale IS NOT NULL
      AND reviewer_uid IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND activated_at IS NOT NULL
    )
  ),
  CONSTRAINT tenant_ed_policies_registry_export_review CHECK (
    registry_export_enabled = FALSE
    OR trauma_registry_participation = 'registry_ready'
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_ed_policies_active
  ON tenant_ed_policies (tenant_id, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_tenant_ed_policies_governance
  ON tenant_ed_policies (clinical_governance_owner_uid, reviewed_at DESC)
  WHERE clinical_governance_owner_uid IS NOT NULL;

ALTER TABLE tenant_ed_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ed_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_ed_policies;
CREATE POLICY tenant_isolation ON tenant_ed_policies
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

COMMIT;
