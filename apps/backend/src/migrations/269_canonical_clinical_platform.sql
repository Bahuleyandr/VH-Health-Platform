-- 269_canonical_clinical_platform.sql
--
-- Canonical clinical platform foundation.
-- Existing feature tables remain the source detail tables for now; these
-- append-only/trace tables provide one patient timeline, encounter lifecycle,
-- normalized audit, workflow SLA tracking, and medication safety review rows.

CREATE TABLE IF NOT EXISTS patient_encounters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_type VARCHAR(40) NOT NULL DEFAULT 'op',
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  appointment_id INTEGER,
  admission_id INTEGER,
  admission_encounter_id UUID,
  primary_doctor_uid UUID,
  care_team_uids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  signed_by UUID,
  amended_at TIMESTAMPTZ,
  amended_by UUID,
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  closed_at TIMESTAMPTZ,
  created_by UUID,
  updated_by UUID,
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_encounters_status_chk
    CHECK (status IN ('open', 'active', 'signed', 'amended', 'locked', 'cancelled')),
  CONSTRAINT patient_encounters_type_chk
    CHECK (encounter_type IN ('op', 'ip', 'er', 'daycare', 'procedure', 'virtual', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_encounters_tenant_appointment
  ON patient_encounters (tenant_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_encounters_tenant_admission
  ON patient_encounters (tenant_id, admission_id)
  WHERE admission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patient_encounters_patient_status
  ON patient_encounters (tenant_id, patient_uid, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_encounters_doctor_status
  ON patient_encounters (tenant_id, primary_doctor_uid, status, opened_at DESC)
  WHERE primary_doctor_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS clinical_timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_uid UUID NOT NULL,
  encounter_id UUID,
  event_type VARCHAR(80) NOT NULL,
  event_subtype VARCHAR(80),
  event_status VARCHAR(40),
  source_table VARCHAR(100),
  source_id VARCHAR(120),
  source_uid UUID,
  resource_type VARCHAR(80),
  resource_id VARCHAR(120),
  actor_uid UUID,
  actor_role VARCHAR(80),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visible_to_patient BOOLEAN NOT NULL DEFAULT FALSE,
  clinical_summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  idempotency_key VARCHAR(220) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_timeline_patient_occurred
  ON clinical_timeline_events (tenant_id, patient_uid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinical_timeline_encounter_occurred
  ON clinical_timeline_events (tenant_id, encounter_id, occurred_at DESC)
  WHERE encounter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_timeline_source
  ON clinical_timeline_events (source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_timeline_event_type
  ON clinical_timeline_events (tenant_id, event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS clinical_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_uid UUID,
  encounter_id UUID,
  action VARCHAR(100) NOT NULL,
  action_status VARCHAR(40) NOT NULL DEFAULT 'success',
  actor_uid UUID,
  actor_role VARCHAR(80),
  resource_type VARCHAR(80),
  resource_table VARCHAR(100),
  resource_id VARCHAR(120),
  request_id VARCHAR(120),
  ip_address INET,
  user_agent TEXT,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(220),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinical_audit_events_idempotency
  ON clinical_audit_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_audit_events_patient_time
  ON clinical_audit_events (tenant_id, patient_uid, occurred_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_audit_events_actor_time
  ON clinical_audit_events (tenant_id, actor_uid, occurred_at DESC)
  WHERE actor_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinical_audit_events_resource
  ON clinical_audit_events (resource_table, resource_id)
  WHERE resource_table IS NOT NULL AND resource_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_sla_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  rule_code VARCHAR(100) NOT NULL,
  title VARCHAR(160) NOT NULL,
  trigger_event_type VARCHAR(100) NOT NULL,
  target_minutes INTEGER NOT NULL,
  severity VARCHAR(30) NOT NULL DEFAULT 'medium',
  owner_role_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  escalation_role_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_sla_rules_tenant_code
  ON workflow_sla_rules (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_code);

CREATE TABLE IF NOT EXISTS workflow_sla_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  rule_id UUID,
  rule_code VARCHAR(100) NOT NULL,
  patient_uid UUID,
  encounter_id UUID,
  source_table VARCHAR(100),
  source_id VARCHAR(120),
  source_uid UUID,
  status VARCHAR(40) NOT NULL DEFAULT 'active',
  priority VARCHAR(30) NOT NULL DEFAULT 'normal',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  breached_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  assigned_role_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  assigned_user_uid UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_sla_instances_status_chk
    CHECK (status IN ('active', 'completed', 'breached', 'escalated', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_sla_instances_source
  ON workflow_sla_instances (tenant_id, rule_code, source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_sla_instances_due
  ON workflow_sla_instances (tenant_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_workflow_sla_instances_patient
  ON workflow_sla_instances (tenant_id, patient_uid, started_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS medication_safety_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_uid UUID,
  patient_id INTEGER,
  encounter_id UUID,
  prescription_id INTEGER,
  clinical_order_id INTEGER,
  review_type VARCHAR(80) NOT NULL,
  severity VARCHAR(30) NOT NULL DEFAULT 'info',
  status VARCHAR(40) NOT NULL DEFAULT 'warning',
  finding_code VARCHAR(100),
  medication_name TEXT,
  message TEXT NOT NULL,
  override_required BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason TEXT,
  overridden_by UUID,
  overridden_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medication_safety_reviews_patient_time
  ON medication_safety_reviews (tenant_id, patient_uid, created_at DESC)
  WHERE patient_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medication_safety_reviews_prescription
  ON medication_safety_reviews (prescription_id, created_at DESC)
  WHERE prescription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medication_safety_reviews_status
  ON medication_safety_reviews (tenant_id, status, severity, created_at DESC);

INSERT INTO workflow_sla_rules
  (rule_code, title, trigger_event_type, target_minutes, severity, owner_role_codes, escalation_role_codes, metadata)
VALUES
  ('referral_response', 'Referral response time', 'referral.requested', 60, 'high',
   ARRAY['DOCTOR', 'CONSULTANT']::TEXT[], ARRAY['CMO', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"description":"Time from referral request to first seen/acceptance"}'::jsonb),
  ('critical_result_ack', 'Critical result acknowledgement', 'investigation.result_critical', 15, 'critical',
   ARRAY['DOCTOR', 'LAB_STAFF']::TEXT[], ARRAY['CMO', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"description":"Critical investigation result acknowledgement"}'::jsonb),
  ('bed_cleaning_turnaround', 'Bed cleaning turnaround', 'bed.cleaning_requested', 30, 'medium',
   ARRAY['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE']::TEXT[], ARRAY['ADMIN']::TEXT[],
   '{"description":"Time from bed cleaning request to available"}'::jsonb),
  ('discharge_blocker_clearance', 'Discharge blocker clearance', 'discharge.blocker_opened', 120, 'high',
   ARRAY['DOCTOR', 'PHARMACY_STAFF', 'BILLING_STAFF']::TEXT[], ARRAY['ADMIN', 'MEDICAL_SUPERINTENDENT']::TEXT[],
   '{"description":"Role-owned discharge blockers must be cleared before final discharge"}'::jsonb)
ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  enabled = TRUE,
  updated_at = NOW();
