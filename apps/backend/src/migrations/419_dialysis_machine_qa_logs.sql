-- 419_dialysis_machine_qa_logs.sql
-- NL6-09: non-clinical dialysis machine disinfection/turnaround QA. These
-- rows are operational records, not patient timeline events; the application
-- warns when missing or failed but does not hard-block the dialysis lifecycle.

CREATE TABLE IF NOT EXISTS dialysis_machine_qa_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  machine_no VARCHAR(40) NOT NULL,
  session_id INTEGER REFERENCES dialysis_sessions(id) ON DELETE SET NULL,
  qa_date DATE NOT NULL DEFAULT CURRENT_DATE,
  disinfection_completed BOOLEAN NOT NULL DEFAULT FALSE,
  disinfection_method VARCHAR(120),
  disinfectant_lot VARCHAR(120),
  turnaround_started_at TIMESTAMPTZ(6),
  turnaround_completed_at TIMESTAMPTZ(6),
  machine_ready BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  warn_only BOOLEAN NOT NULL DEFAULT TRUE,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_dialysis_machine_qa_logs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_dialysis_machine_qa_logs_status
    CHECK (status IN ('pending', 'passed', 'failed', 'maintenance_required')),
  CONSTRAINT chk_dialysis_machine_qa_logs_turnaround
    CHECK (
      turnaround_completed_at IS NULL
      OR turnaround_started_at IS NULL
      OR turnaround_completed_at >= turnaround_started_at
    ),
  CONSTRAINT chk_dialysis_machine_qa_logs_issues_array
    CHECK (jsonb_typeof(issues) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_dialysis_machine_qa_logs_machine_date
  ON dialysis_machine_qa_logs (tenant_id, machine_no, qa_date DESC, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_dialysis_machine_qa_logs_session
  ON dialysis_machine_qa_logs (tenant_id, session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE dialysis_machine_qa_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dialysis_machine_qa_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON dialysis_machine_qa_logs;
CREATE POLICY tenant_isolation ON dialysis_machine_qa_logs
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
