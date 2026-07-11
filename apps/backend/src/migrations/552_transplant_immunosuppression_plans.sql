-- NL-13 P6: transplant immunosuppression plans.

CREATE TABLE IF NOT EXISTS transplant_immunosuppression_plans (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  candidate_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  regimen_summary TEXT NOT NULL,
  monitoring_plan TEXT NOT NULL,
  prescribing_owner_uid UUID NOT NULL,
  downstream_medication_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  timeline_event_id UUID,
  audit_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT transplant_immunosuppression_plans_status_check
    CHECK (status IN ('draft', 'active', 'on_hold', 'discontinued')),
  CONSTRAINT transplant_immunosuppression_plans_links_check
    CHECK (jsonb_typeof(downstream_medication_links) = 'array'),
  CONSTRAINT fk_transplant_immunosuppression_candidate
    FOREIGN KEY (candidate_id) REFERENCES transplant_candidates(id) ON DELETE CASCADE,
  CONSTRAINT fk_transplant_immunosuppression_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_transplant_immunosuppression_candidate
  ON transplant_immunosuppression_plans (tenant_id, candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transplant_immunosuppression_patient
  ON transplant_immunosuppression_plans (tenant_id, patient_uid, status);

ALTER TABLE transplant_immunosuppression_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE transplant_immunosuppression_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transplant_immunosuppression_plans;
CREATE POLICY tenant_isolation ON transplant_immunosuppression_plans
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
