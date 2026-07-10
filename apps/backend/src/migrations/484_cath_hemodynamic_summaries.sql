-- NL-13 P1: cath-lab hemodynamic summaries, with summary references only.

CREATE TABLE IF NOT EXISTS cath_hemodynamic_summaries (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  summary_text TEXT,
  observations JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  device_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_system VARCHAR(160),
  source_version VARCHAR(80),
  recorded_by UUID,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_hemodynamic_summaries_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_cath_hemo_case
  ON cath_hemodynamic_summaries (tenant_id, case_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_hemo_patient
  ON cath_hemodynamic_summaries (tenant_id, patient_uid, recorded_at DESC);

ALTER TABLE cath_hemodynamic_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_hemodynamic_summaries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_hemodynamic_summaries;
CREATE POLICY tenant_isolation ON cath_hemodynamic_summaries
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
