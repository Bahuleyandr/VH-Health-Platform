-- NL-13 P1: cath-lab cases and readiness checklist.

CREATE TABLE IF NOT EXISTS cath_lab_cases (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  encounter_id UUID REFERENCES patient_encounters(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  requested_procedure VARCHAR(160) NOT NULL,
  indication TEXT,
  urgency VARCHAR(30) NOT NULL DEFAULT 'routine',
  lab_room VARCHAR(120),
  status VARCHAR(40) NOT NULL DEFAULT 'scheduled',
  planned_start_at TIMESTAMPTZ(6),
  planned_end_at TIMESTAMPTZ(6),
  actual_start_at TIMESTAMPTZ(6),
  actual_end_at TIMESTAMPTZ(6),
  team JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeline_event_id UUID REFERENCES clinical_timeline_events(id) ON DELETE SET NULL,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  sla_rule_code VARCHAR(100),
  sla_instance_id UUID REFERENCES workflow_sla_instances(id) ON DELETE SET NULL,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_lab_cases_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_lab_cases_urgency_check
    CHECK (urgency IN ('elective', 'routine', 'urgent', 'emergency')),
  CONSTRAINT cath_lab_cases_status_check
    CHECK (status IN ('requested', 'scheduled', 'readiness_pending', 'ready', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT cath_lab_cases_planned_time_check
    CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at >= planned_start_at),
  CONSTRAINT cath_lab_cases_actual_time_check
    CHECK (actual_end_at IS NULL OR actual_start_at IS NULL OR actual_end_at >= actual_start_at)
);

CREATE INDEX IF NOT EXISTS idx_cath_lab_cases_schedule
  ON cath_lab_cases (tenant_id, planned_start_at, status);

CREATE INDEX IF NOT EXISTS idx_cath_lab_cases_patient
  ON cath_lab_cases (tenant_id, patient_uid, planned_start_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_lab_cases_encounter
  ON cath_lab_cases (tenant_id, encounter_id)
  WHERE encounter_id IS NOT NULL;

ALTER TABLE cath_lab_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_cases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_lab_cases;
CREATE POLICY tenant_isolation ON cath_lab_cases
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

CREATE TABLE IF NOT EXISTS cath_lab_readiness_checks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  check_type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  required BOOLEAN NOT NULL DEFAULT TRUE,
  completed_by UUID,
  completed_at TIMESTAMPTZ(6),
  evidence_owner VARCHAR(160),
  source_name VARCHAR(160),
  source_version VARCHAR(80),
  attachment_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_lab_readiness_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_lab_readiness_type_check
    CHECK (check_type IN ('consent', 'labs', 'allergy_renal_risk', 'anticoagulation', 'blood_bank', 'equipment', 'implants_device_rep', 'timeout')),
  CONSTRAINT cath_lab_readiness_status_check
    CHECK (status IN ('pending', 'pass', 'fail', 'waived', 'not_applicable')),
  CONSTRAINT cath_lab_readiness_completion_check
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR (status <> 'pending')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_lab_readiness_case_type
  ON cath_lab_readiness_checks (tenant_id, case_id, check_type);

CREATE INDEX IF NOT EXISTS idx_cath_lab_readiness_status
  ON cath_lab_readiness_checks (tenant_id, case_id, status);

ALTER TABLE cath_lab_readiness_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_readiness_checks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_lab_readiness_checks;
CREATE POLICY tenant_isolation ON cath_lab_readiness_checks
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
