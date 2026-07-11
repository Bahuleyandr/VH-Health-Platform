-- NL-13 P4: radiation-safety / AERB-adjacent owner-sourced evidence register.
-- This is EQUIPMENT / QA evidence — a register/audit subject, NOT a patient timeline
-- event: no patient_uid and no canonical_timeline_event_id here. Every owner/source/
-- version/attachment slot ships INERT and stays empty until the operator supplies the
-- real evidence. The product NEVER encodes AERB radiation-equipment licensing, QA,
-- radiation-safety, radioisotope-handling, or delivery requirements from model memory.

BEGIN;

CREATE TABLE IF NOT EXISTS radiation_safety_evidence (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  evidence_type                 VARCHAR(60) NOT NULL DEFAULT 'equipment_qa',
  title                         VARCHAR(200),
  equipment_ref                 VARCHAR(160),
  evidence_owner                VARCHAR(160),
  source_name                   VARCHAR(160),
  source_version                VARCHAR(80),
  attachment_ref                TEXT,
  equipment_qa_reference        TEXT,
  reference_period_start        DATE,
  reference_period_end          DATE,
  status                        VARCHAR(40) NOT NULL DEFAULT 'pending',
  related_referral_id           BIGINT REFERENCES radiation_oncology_referrals(id) ON DELETE SET NULL,
  related_plan_ref_id           BIGINT REFERENCES radiotherapy_plan_refs(id) ON DELETE SET NULL,
  related_nuclear_order_id      BIGINT REFERENCES nuclear_medicine_orders(id) ON DELETE SET NULL,
  clinical_audit_event_id       UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  recorded_by                   UUID,
  created_by                    UUID,
  updated_by                    UUID,
  created_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata                      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_radiation_safety_evidence_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_radiation_safety_evidence_type
    CHECK (evidence_type IN ('equipment_licensing', 'equipment_qa', 'radiation_safety', 'radioisotope_handling', 'delivery_qa', 'other')),
  CONSTRAINT chk_radiation_safety_evidence_status
    CHECK (status IN ('pending', 'active', 'expired', 'superseded')),
  CONSTRAINT chk_radiation_safety_evidence_period
    CHECK (reference_period_end IS NULL OR reference_period_start IS NULL OR reference_period_end >= reference_period_start),
  CONSTRAINT chk_radiation_safety_evidence_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_radiation_safety_evidence_type
  ON radiation_safety_evidence (tenant_id, evidence_type, status);

CREATE INDEX IF NOT EXISTS idx_radiation_safety_evidence_equipment
  ON radiation_safety_evidence (tenant_id, equipment_ref)
  WHERE equipment_ref IS NOT NULL;

ALTER TABLE radiation_safety_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE radiation_safety_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON radiation_safety_evidence;
CREATE POLICY tenant_isolation ON radiation_safety_evidence
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL13_P4_RADIATION_SAFETY_EVIDENCE_APPLIED',
  'radiation_safety_evidence',
  '511_radiation_safety_evidence.sql',
  jsonb_build_object(
    'migration', '511_radiation_safety_evidence.sql',
    'suite', 'NL-13 P4 nuclear medicine & radiotherapy coordination',
    'owner_sourced', true,
    'register_audit_only', true,
    'not_patient_timeline', true,
    'inert_by_default', true
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL13_P4_RADIATION_SAFETY_EVIDENCE_APPLIED'
    AND resource_id = '511_radiation_safety_evidence.sql'
);

COMMIT;
