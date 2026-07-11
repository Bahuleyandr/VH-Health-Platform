-- NL-13 P1: cath-lab procedure logs.

CREATE TABLE IF NOT EXISTS cath_procedure_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  procedure_type VARCHAR(120) NOT NULL,
  access_site VARCHAR(120),
  operators JSONB NOT NULL DEFAULT '[]'::jsonb,
  sedation_anesthesia_ref VARCHAR(160),
  devices JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings_summary TEXT,
  complications JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'finalized',
  started_at TIMESTAMPTZ(6),
  ended_at TIMESTAMPTZ(6),
  logged_by UUID,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_procedure_logs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_procedure_logs_status_check
    CHECK (status IN ('draft', 'finalized', 'amended')),
  CONSTRAINT cath_procedure_logs_time_check
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_logs_case
  ON cath_procedure_logs (tenant_id, case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_procedure_logs_patient
  ON cath_procedure_logs (tenant_id, patient_uid, created_at DESC);

ALTER TABLE cath_procedure_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_procedure_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_procedure_logs;
CREATE POLICY tenant_isolation ON cath_procedure_logs
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
