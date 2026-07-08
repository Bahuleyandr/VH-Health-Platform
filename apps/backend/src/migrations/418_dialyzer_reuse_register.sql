-- 418_dialyzer_reuse_register.sql
-- NL6-09: serial-tracked dialyzer reuse register. The authoritative Indian
-- statutory form is still pending owner sourcing, so rows carry
-- register_format_status='format_pending' until the format is confirmed.

CREATE TABLE IF NOT EXISTS dialyzer_reuse_register (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  session_id INTEGER NOT NULL REFERENCES dialysis_sessions(id) ON DELETE CASCADE,
  dialysis_patient_id INTEGER NOT NULL REFERENCES dialysis_patients(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  dialyzer_serial VARCHAR(80) NOT NULL,
  reuse_cycle_count INTEGER NOT NULL,
  session_reuse_count INTEGER,
  integrity_test_result VARCHAR(20) NOT NULL DEFAULT 'pending',
  integrity_test_method VARCHAR(120),
  disinfectant VARCHAR(80),
  processed_by UUID,
  processed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'in_use',
  discard_reason VARCHAR(255),
  register_format_status VARCHAR(30) NOT NULL DEFAULT 'format_pending',
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_dialyzer_reuse_register_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_dialyzer_reuse_cycle_count
    CHECK (reuse_cycle_count >= 0 AND reuse_cycle_count <= 100),
  CONSTRAINT chk_dialyzer_reuse_integrity
    CHECK (integrity_test_result IN ('pending', 'pass', 'fail', 'not_done')),
  CONSTRAINT chk_dialyzer_reuse_status
    CHECK (status IN ('in_use', 'discarded', 'quarantined')),
  CONSTRAINT chk_dialyzer_reuse_format_status
    CHECK (register_format_status IN ('format_pending', 'format_confirmed')),
  CONSTRAINT chk_dialyzer_reuse_discard_reason
    CHECK (
      status <> 'discarded'
      OR NULLIF(BTRIM(discard_reason), '') IS NOT NULL
    ),
  CONSTRAINT chk_dialyzer_reuse_failed_integrity_disposition
    CHECK (
      integrity_test_result <> 'fail'
      OR status IN ('discarded', 'quarantined')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_dialyzer_reuse_register_session
  ON dialyzer_reuse_register (tenant_id, session_id);

CREATE INDEX IF NOT EXISTS idx_dialyzer_reuse_register_patient
  ON dialyzer_reuse_register (tenant_id, dialysis_patient_id, processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dialyzer_reuse_register_serial
  ON dialyzer_reuse_register (tenant_id, dialyzer_serial, reuse_cycle_count DESC);

ALTER TABLE dialyzer_reuse_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE dialyzer_reuse_register FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON dialyzer_reuse_register;
CREATE POLICY tenant_isolation ON dialyzer_reuse_register
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
