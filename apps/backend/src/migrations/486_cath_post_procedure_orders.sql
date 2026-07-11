-- NL-13 P1: cath-lab post-procedure order summaries.

CREATE TABLE IF NOT EXISTS cath_post_procedure_orders (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  recovery_location VARCHAR(160),
  sheath_management TEXT,
  vascular_closure TEXT,
  vitals_frequency VARCHAR(120),
  antiplatelet_plan TEXT,
  anticoagulation_plan TEXT,
  complication_watch JSONB NOT NULL DEFAULT '[]'::jsonb,
  order_status VARCHAR(30) NOT NULL DEFAULT 'active',
  ordered_by UUID,
  ordered_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_post_orders_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_post_orders_status_check
    CHECK (order_status IN ('draft', 'active', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_cath_post_orders_case
  ON cath_post_procedure_orders (tenant_id, case_id, ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_post_orders_patient
  ON cath_post_procedure_orders (tenant_id, patient_uid, ordered_at DESC);

ALTER TABLE cath_post_procedure_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_post_procedure_orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_post_procedure_orders;
CREATE POLICY tenant_isolation ON cath_post_procedure_orders
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
