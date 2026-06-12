-- 300_india_deployability_controls.sql
--
-- India deployability baseline, 2026-06-12.
--
-- This migration does not claim statutory compliance. It makes India rollout
-- evidence machine-checkable by:
--   * seeding baseline data-processing activities and retention policies,
--   * creating a tenant-scoped evidence ledger for DPDP/ABDM/NABH/CERT-In/
--     DR/VAPT/SIEM/billing/pharmacy controls,
--   * leaving evidence rows pending until hospital/operator sign-off is
--     attached.

BEGIN;

INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'default',
  'VH Health Default Tenant',
  'IN',
  'DPDP',
  'active',
  '{}'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  region = 'IN',
  compliance_profile = 'DPDP',
  updated_at = NOW();

WITH activity_rows (
  activity_code, display_name, description, purposes, data_subject_categories,
  personal_data_categories, special_category_data, recipient_categories,
  cross_border_transfers, retention_period_days, retention_basis,
  security_measures, lawful_basis, dpia_required, metadata
) AS (
  VALUES
    (
      'INDIA_TREATMENT_CARE_RECORDS',
      'Treatment and clinical care records',
      'Core OPD/IPD/ER clinical records, orders, observations, notes, MAR, discharge, and continuity-of-care documents.',
      'Provision of healthcare, clinical safety, continuity of care, medico-legal documentation',
      ARRAY['patients', 'guardians', 'clinicians'],
      ARRAY['identity', 'contact', 'demographics', 'encounter', 'billing-reference'],
      ARRAY['health data', 'prescriptions', 'diagnostics', 'clinical notes'],
      ARRAY['hospital care team', 'authorized processors'],
      false,
      3650,
      'Hospital medico-legal retention schedule; counsel to approve per facility.',
      'Tenant RLS, audit logging, access controls, encrypted backup, least-privilege roles',
      'medical_care',
      true,
      '{"baseline":"india_deployability_2026_06_12"}'::jsonb
    ),
    (
      'INDIA_CONSENT_RIGHTS',
      'Consent and data-principal rights handling',
      'Consent capture, withdrawal, DSR/DSAR intake, correction, restriction, erasure decision, and grievance routing.',
      'Consent lifecycle and Data Principal rights request handling',
      ARRAY['patients', 'guardians', 'authorized representatives'],
      ARRAY['identity', 'contact', 'request metadata'],
      ARRAY['health data references'],
      ARRAY['hospital privacy office', 'authorized processors'],
      false,
      2555,
      'Privacy office evidence retention; counsel to approve.',
      'Tenant RLS, event outbox, PHI access audit, evidence ledger',
      'legal_obligation',
      true,
      '{"baseline":"india_deployability_2026_06_12"}'::jsonb
    ),
    (
      'INDIA_ABDM_EXCHANGE',
      'ABDM/ABHA health information exchange',
      'ABHA linking, consent artifacts, care contexts, HIP data push, webhook events, and certification evidence.',
      'Patient-authorized health information exchange through ABDM',
      ARRAY['patients', 'guardians'],
      ARRAY['identity', 'ABHA identifiers', 'consent metadata'],
      ARRAY['health records', 'FHIR bundles'],
      ARRAY['ABDM gateway', 'HIU/HIP participants'],
      false,
      2555,
      'ABDM certification and consent audit retention; counsel to approve.',
      'Signed callbacks, replay guard, encrypted FHIR data push, SSRF guard, tenant RLS',
      'consent',
      true,
      '{"baseline":"india_deployability_2026_06_12"}'::jsonb
    ),
    (
      'INDIA_BILLING_PAYMENTS',
      'Billing, GST, payer, and payment records',
      'Invoices, payment links, payments, refunds, TPA/cashless claims, tariffs, and financial audit trails.',
      'Billing, payment collection, payer reconciliation, financial audit',
      ARRAY['patients', 'guardians', 'payers'],
      ARRAY['identity', 'contact', 'payment metadata', 'invoice data'],
      ARRAY['health-service billing references'],
      ARRAY['hospital billing team', 'payment processors', 'TPA/payers'],
      false,
      2920,
      'Finance/tax and hospital record retention; counsel/accountant to approve.',
      'Tenant RLS, audit logging, payment-link expiry, role-gated billing operations',
      'contract',
      true,
      '{"baseline":"india_deployability_2026_06_12"}'::jsonb
    ),
    (
      'INDIA_PHARMACY_SUPPLY',
      'Pharmacy orders, inventory, supplier, and dispensing records',
      'Prescription-backed pharmacy orders, inventory batches, expiry alerts, suppliers, purchase orders, GRNs, and substitutions.',
      'Medication dispensing, inventory control, supplier traceability, drug-license audit',
      ARRAY['patients', 'pharmacy staff', 'suppliers'],
      ARRAY['identity', 'contact', 'supplier identifiers', 'order metadata'],
      ARRAY['prescriptions', 'dispensing records'],
      ARRAY['hospital pharmacy', 'licensed suppliers', 'authorized processors'],
      false,
      3650,
      'Drugs and Cosmetics/pharmacy audit schedule; pharmacist/counsel to approve.',
      'Tenant RLS, batch/expiry tracking, supplier license fields, audit logs',
      'medical_care',
      true,
      '{"baseline":"india_deployability_2026_06_12"}'::jsonb
    ),
    (
      'INDIA_AUDIT_SECURITY',
      'Security monitoring, audit logs, SIEM, and incident response',
      'Application/security logs, PHI access audit, hash-chain evidence, incident records, VAPT findings, SIEM alerts, and CERT-In reporting evidence.',
      'Security monitoring, incident response, audit, and regulatory reporting',
      ARRAY['patients', 'staff', 'administrators'],
      ARRAY['identity', 'device', 'IP address', 'access metadata'],
      ARRAY['health-data access metadata'],
      ARRAY['hospital security team', 'SOC/SIEM provider', 'regulators when required'],
      false,
      365,
      'At least 180 days security log retention for CERT-In readiness; hospital may require longer.',
      'Hash chain, PHI redaction, SIEM archive, privileged access review',
      'security',
      true,
      '{"baseline":"india_deployability_2026_06_12","minimum_security_log_days":180}'::jsonb
    )
)
INSERT INTO data_processing_activities (
  tenant_id, activity_code, display_name, description, purposes,
  data_subject_categories, personal_data_categories, special_category_data,
  recipient_categories, cross_border_transfers, retention_period_days,
  retention_basis, security_measures, lawful_basis, dpia_required,
  status, metadata, created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  activity_code, display_name, description, purposes,
  data_subject_categories, personal_data_categories, special_category_data,
  recipient_categories, cross_border_transfers, retention_period_days,
  retention_basis, security_measures, lawful_basis, dpia_required,
  'active', metadata, NOW(), NOW()
FROM activity_rows
ON CONFLICT (tenant_id, activity_code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  purposes = EXCLUDED.purposes,
  data_subject_categories = EXCLUDED.data_subject_categories,
  personal_data_categories = EXCLUDED.personal_data_categories,
  special_category_data = EXCLUDED.special_category_data,
  recipient_categories = EXCLUDED.recipient_categories,
  retention_period_days = EXCLUDED.retention_period_days,
  retention_basis = EXCLUDED.retention_basis,
  security_measures = EXCLUDED.security_measures,
  lawful_basis = EXCLUDED.lawful_basis,
  dpia_required = EXCLUDED.dpia_required,
  metadata = data_processing_activities.metadata || EXCLUDED.metadata,
  status = 'active',
  updated_at = NOW();

WITH retention_rows (
  policy_code, applies_to_table, display_name, retention_days, action, basis,
  activity_code, metadata
) AS (
  VALUES
    ('INDIA_USERS_RETENTION', 'users', 'Patient/staff identity retention', 3650, 'archive', 'Clinical identity and medico-legal continuity; counsel to approve.', 'INDIA_TREATMENT_CARE_RECORDS', '{"india_gate":"dpdp"}'::jsonb),
    ('INDIA_PATIENT_CONSENTS_RETENTION', 'patient_consents', 'Consent evidence retention', 2555, 'archive', 'Consent and withdrawal evidence; counsel to approve.', 'INDIA_CONSENT_RIGHTS', '{"india_gate":"dpdp"}'::jsonb),
    ('INDIA_DSR_RETENTION', 'patient_data_rights_requests', 'Data-principal request evidence retention', 2555, 'archive', 'DSR/DSAR, grievance, restriction, correction, erasure decision evidence.', 'INDIA_CONSENT_RIGHTS', '{"india_gate":"dpdp"}'::jsonb),
    ('INDIA_ABDM_CONSENT_ARTIFACTS_RETENTION', 'abdm_consent_artifacts', 'ABDM consent artifact retention', 2555, 'archive', 'ABDM consent and certification traceability.', 'INDIA_ABDM_EXCHANGE', '{"india_gate":"abdm"}'::jsonb),
    ('INDIA_ABDM_DATA_REQUESTS_RETENTION', 'abdm_data_requests', 'ABDM data request retention', 2555, 'archive', 'ABDM HIP data-push traceability.', 'INDIA_ABDM_EXCHANGE', '{"india_gate":"abdm"}'::jsonb),
    ('INDIA_ABDM_TRANSFERS_RETENTION', 'abdm_data_transfers', 'ABDM data transfer retention', 2555, 'archive', 'ABDM encrypted-transfer and notify evidence.', 'INDIA_ABDM_EXCHANGE', '{"india_gate":"abdm"}'::jsonb),
    ('INDIA_ABDM_WEBHOOKS_RETENTION', 'abdm_webhook_events', 'ABDM webhook event retention', 2555, 'archive', 'ABDM callback authenticity and replay evidence.', 'INDIA_ABDM_EXCHANGE', '{"india_gate":"abdm"}'::jsonb),
    ('INDIA_AUDIT_LOGS_RETENTION', 'audit_logs', 'Application audit log retention', 365, 'archive', 'Security and privacy audit readiness; at least 180 days searchable in India jurisdiction.', 'INDIA_AUDIT_SECURITY', '{"india_gate":"cert_in","minimum_days":180}'::jsonb),
    ('INDIA_CLINICAL_AUDIT_RETENTION', 'clinical_audit_events', 'Tamper-evident clinical audit retention', 3650, 'archive', 'Medico-legal and NABH audit trail.', 'INDIA_AUDIT_SECURITY', '{"india_gate":"nabh"}'::jsonb),
    ('INDIA_NABH_SNAPSHOTS_RETENTION', 'nabh_indicator_snapshots', 'NABH indicator snapshot retention', 2555, 'archive', 'Assessor pack evidence.', 'INDIA_AUDIT_SECURITY', '{"india_gate":"nabh"}'::jsonb),
    ('INDIA_BILLING_INVOICES_RETENTION', 'billing_invoices', 'Billing invoice retention', 2920, 'archive', 'Finance, GST, payer, and hospital audit retention.', 'INDIA_BILLING_PAYMENTS', '{"india_gate":"billing"}'::jsonb),
    ('INDIA_BILLING_PAYMENTS_RETENTION', 'billing_payments', 'Billing payment retention', 2920, 'archive', 'Payment and reconciliation evidence.', 'INDIA_BILLING_PAYMENTS', '{"india_gate":"billing"}'::jsonb),
    ('INDIA_PHARMACY_ORDERS_RETENTION', 'pharmacy_orders', 'Pharmacy order retention', 3650, 'archive', 'Prescription-backed dispensing and patient safety evidence.', 'INDIA_PHARMACY_SUPPLY', '{"india_gate":"pharmacy"}'::jsonb),
    ('INDIA_PHARMACY_BATCH_RETENTION', 'pharmacy_inventory_batches', 'Pharmacy inventory batch retention', 3650, 'archive', 'Batch, expiry, supplier, and recall traceability.', 'INDIA_PHARMACY_SUPPLY', '{"india_gate":"pharmacy"}'::jsonb),
    ('INDIA_PHARMACY_SUPPLIERS_RETENTION', 'pharmacy_suppliers', 'Pharmacy supplier retention', 3650, 'archive', 'Supplier drug-license/GST/PAN audit trail.', 'INDIA_PHARMACY_SUPPLY', '{"india_gate":"pharmacy"}'::jsonb)
)
INSERT INTO data_retention_policies (
  tenant_id, policy_code, applies_to_table, display_name, description,
  retention_days, action, basis, legal_hold_aware,
  data_processing_activity_id, status, metadata, created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  rr.policy_code,
  rr.applies_to_table,
  rr.display_name,
  'Seeded India deployment baseline; hospital counsel must approve or replace per facility.',
  rr.retention_days,
  rr.action,
  rr.basis,
  true,
  dpa.id,
  'active',
  rr.metadata || '{"baseline":"india_deployability_2026_06_12","requires_hospital_approval":true}'::jsonb,
  NOW(),
  NOW()
FROM retention_rows rr
LEFT JOIN data_processing_activities dpa
  ON dpa.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
 AND dpa.activity_code = rr.activity_code
ON CONFLICT (tenant_id, applies_to_table) DO UPDATE SET
  metadata = data_retention_policies.metadata
    || '{"india_baseline_present":true,"requires_hospital_approval":true}'::jsonb,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS india_compliance_evidence (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  control_code  VARCHAR(80) NOT NULL,
  control_area  VARCHAR(40) NOT NULL,
  control_name  VARCHAR(255) NOT NULL,
  status        VARCHAR(30) NOT NULL DEFAULT 'pending',
  evidence_uri  TEXT,
  owner_uid     UUID,
  due_at        TIMESTAMPTZ(6),
  verified_by   UUID,
  verified_at   TIMESTAMPTZ(6),
  notes         TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_india_compliance_evidence_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT uq_india_compliance_evidence_control
    UNIQUE (tenant_id, control_code),
  CONSTRAINT india_compliance_evidence_status_check
    CHECK (status IN ('pending', 'in_progress', 'verified', 'accepted_exception', 'not_applicable'))
);

CREATE INDEX IF NOT EXISTS idx_india_compliance_evidence_status
  ON india_compliance_evidence (tenant_id, status, control_area);

CREATE INDEX IF NOT EXISTS idx_india_compliance_evidence_due
  ON india_compliance_evidence (due_at)
  WHERE status IN ('pending', 'in_progress');

ALTER TABLE india_compliance_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE india_compliance_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON india_compliance_evidence;
CREATE POLICY tenant_isolation ON india_compliance_evidence
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

WITH evidence_rows (control_code, control_area, control_name, metadata) AS (
  VALUES
    ('DPDP_NOTICE_PURPOSE_MAP', 'DPDP', 'Privacy notice and processing-purpose map approved', '{"doc":"docs/india-deployment-readiness.md#3-dpdp-act-and-rules"}'::jsonb),
    ('DPDP_DSR_DRY_RUN', 'DPDP', 'Five-scenario data-principal request dry run completed', '{"scenarios":["inpatient","opd","minor_guardian","withdrawn_consent","retention_denial"]}'::jsonb),
    ('DPDP_RETENTION_SCHEDULE', 'DPDP', 'Hospital retention schedule approved against seeded policies', '{"table":"data_retention_policies"}'::jsonb),
    ('ABDM_CALLBACK_AUTHENTICITY', 'ABDM', 'ABDM callback HMAC/timestamp/replay validation proven in logs', '{"env":["ABDM_CALLBACK_SECRET","ABDM_HIP_ID"]}'::jsonb),
    ('ABDM_M2_ENCRYPTED_PUSH', 'ABDM', 'ABDM M2 encrypted data-push dry run passed', '{"docs":"docs/ABDM_READINESS.md"}'::jsonb),
    ('NABH_AUDIT_EXPORT', 'NABH', 'NABH indicator snapshot and assessor export evidence attached', '{"table":"nabh_indicator_snapshots"}'::jsonb),
    ('INDIA_LOG_RETENTION_180D', 'CERT_IN', 'Security/application logs retained 180 days in Indian jurisdiction', '{"minimum_days":180}'::jsonb),
    ('DR_RESTORE_DRILL', 'DR', 'Timed restore and downtime drill evidence attached', '{"docs":["docs/DR_RESTORE_DRILL.md","docs/DOWNTIME_PROCEDURE.md"]}'::jsonb),
    ('VAPT_OR_SIGNED_EXCEPTION', 'SECURITY', 'External VAPT report or signed high-risk exception attached', '{"docs":"docs/SECURITY_HARDENING_CHECKLIST.md"}'::jsonb),
    ('SIEM_ALERTS_ONCALL', 'SECURITY', 'SIEM/on-call alert routing verified for security incidents', '{"minimum":"critical and high security events"}'::jsonb),
    ('LOCAL_REGION_BACKUP_JURISDICTION', 'DR', 'India-region/on-prem backup and log-storage jurisdiction approved', '{"evidence":"contract or storage policy"}'::jsonb),
    ('IMAGE_SIGNATURE_ADMISSION', 'SECURITY', 'Image signature admission policy enabled or exception accepted', '{"control":"Kyverno verifyImages / equivalent"}'::jsonb),
    ('BILLING_GST_TPA_RECON', 'BILLING', 'GST/TPA/billing reconciliation workflow approved', '{"tables":["billing_invoices","billing_payments","tpa_claims"]}'::jsonb),
    ('PHARMACY_LICENSE_PRESCRIPTION_CONTROL', 'PHARMACY', 'Pharmacy supplier license, batch/expiry, and prescription-control evidence approved', '{"tables":["pharmacy_suppliers","pharmacy_inventory_batches","pharmacy_orders"]}'::jsonb)
)
INSERT INTO india_compliance_evidence (
  tenant_id, control_code, control_area, control_name, status, metadata,
  created_at, updated_at
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  control_code,
  control_area,
  control_name,
  'pending',
  metadata || '{"baseline":"india_deployability_2026_06_12"}'::jsonb,
  NOW(),
  NOW()
FROM evidence_rows
ON CONFLICT (tenant_id, control_code) DO NOTHING;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'INDIA_DEPLOYABILITY_CONTROLS_SEEDED',
  'india_compliance_evidence',
  'default',
  jsonb_build_object(
    'migration', '300_india_deployability_controls.sql',
    'retention_policies_seeded', true,
    'evidence_controls_seeded', true,
    'note', 'Baseline only; hospital/operator evidence rows remain pending until verified.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'INDIA_DEPLOYABILITY_CONTROLS_SEEDED'
     AND resource = 'india_compliance_evidence'
);

COMMIT;
