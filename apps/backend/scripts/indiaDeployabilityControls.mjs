export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export const REQUIRED_TABLES = [
  'patient_consents',
  'patient_data_rights_requests',
  'data_processing_activities',
  'data_retention_policies',
  'abdm_webhook_events',
  'nabh_indicator_snapshots',
  'india_compliance_evidence',
  'siem_export_targets',
  'siem_export_cursors',
  'siem_export_events',
  'siem_export_delivery_attempts',
  'billing_invoices',
  'billing_payments',
  'pharmacy_orders',
  'pharmacy_inventory_batches',
  'pharmacy_suppliers',
];

export const RETENTION_TABLES = [
  'users',
  'patient_consents',
  'patient_data_rights_requests',
  'abdm_consent_artifacts',
  'abdm_data_requests',
  'abdm_data_transfers',
  'abdm_webhook_events',
  'audit_logs',
  'clinical_audit_events',
  'siem_export_targets',
  'siem_export_cursors',
  'siem_export_events',
  'siem_export_delivery_attempts',
  'nabh_indicator_snapshots',
  'billing_invoices',
  'billing_payments',
  'pharmacy_orders',
  'pharmacy_inventory_batches',
  'pharmacy_suppliers',
];

export const REQUIRED_EVIDENCE_CONTROLS = [
  {
    control_code: 'DPDP_NOTICE_PURPOSE_MAP',
    control_area: 'DPDP',
    control_name: 'Privacy notice and processing-purpose map approved',
    required_evidence: 'Counsel-approved notice, purpose map, data-sharing list, grievance contact, and consent/notice mapping.',
  },
  {
    control_code: 'DPDP_DSR_DRY_RUN',
    control_area: 'DPDP',
    control_name: 'Five-scenario data-principal request dry run completed',
    required_evidence: 'Dry-run packet covering inpatient, OPD, minor/guardian, withdrawn consent, and retention-denial scenarios.',
  },
  {
    control_code: 'DPDP_RETENTION_SCHEDULE',
    control_area: 'DPDP',
    control_name: 'Hospital retention schedule approved against seeded policies',
    required_evidence: 'Hospital counsel/privacy-office approval for data_retention_policies and any tenant-specific deviations.',
  },
  {
    control_code: 'ABDM_CALLBACK_AUTHENTICITY',
    control_area: 'ABDM',
    control_name: 'ABDM callback HMAC/timestamp/replay validation proven in logs',
    required_evidence: 'Runtime preflight/log excerpt proving callback secret, HIP ID, timestamp, request-id, replay validation, and at least one recent signed callback event.',
  },
  {
    control_code: 'ABDM_M2_ENCRYPTED_PUSH',
    control_area: 'ABDM',
    control_name: 'ABDM M2 encrypted data-push dry run passed',
    required_evidence: 'Sandbox M2 HIP data-push dry-run output showing encrypted payload, notify leg, and no plaintext bundle push.',
  },
  {
    control_code: 'NABH_AUDIT_EXPORT',
    control_area: 'NABH',
    control_name: 'NABH indicator snapshot and assessor export evidence attached',
    required_evidence: 'NABH snapshot/export packet with assessor-facing indicators and clinical owner sign-off.',
  },
  {
    control_code: 'INDIA_LOG_RETENTION_180D',
    control_area: 'CERT_IN',
    control_name: 'Security/application logs retained 180 days in Indian jurisdiction',
    required_evidence: 'SIEM/object-storage/log-retention proof for at least 180 days in Indian jurisdiction.',
  },
  {
    control_code: 'DR_RESTORE_DRILL',
    control_area: 'DR',
    control_name: 'Timed restore and downtime drill evidence attached',
    required_evidence: 'Timed restore evidence, RPO/RTO approval, downtime pack drill, and clinically meaningful read checks.',
  },
  {
    control_code: 'VAPT_OR_SIGNED_EXCEPTION',
    control_area: 'SECURITY',
    control_name: 'External VAPT report or signed high-risk exception attached',
    required_evidence: 'Current VAPT report with closure evidence, or named-risk exception signed by hospital/security owner.',
  },
  {
    control_code: 'SIEM_ALERTS_ONCALL',
    control_area: 'SECURITY',
    control_name: 'SIEM/on-call alert routing verified for security incidents',
    required_evidence: 'High/critical security alert route test with minimized SIEM payload, delivery/retry rows, on-call acknowledgement, and escalation owner.',
  },
  {
    control_code: 'LOCAL_REGION_BACKUP_JURISDICTION',
    control_area: 'DR',
    control_name: 'India-region/on-prem backup and log-storage jurisdiction approved',
    required_evidence: 'Storage jurisdiction proof for backups/logs and approval for any cross-border processing.',
  },
  {
    control_code: 'IMAGE_SIGNATURE_ADMISSION',
    control_area: 'SECURITY',
    control_name: 'Image signature admission policy enabled or exception accepted',
    required_evidence: 'Kyverno/equivalent verifyImages admission evidence, or signed exception with compensating controls.',
  },
  {
    control_code: 'BILLING_GST_TPA_RECON',
    control_area: 'BILLING',
    control_name: 'GST/TPA/billing reconciliation workflow approved',
    required_evidence: 'Billing/GST/TPA reconciliation UAT packet and finance owner approval.',
  },
  {
    control_code: 'PHARMACY_LICENSE_PRESCRIPTION_CONTROL',
    control_area: 'PHARMACY',
    control_name: 'Pharmacy supplier license, batch/expiry, and prescription-control evidence approved',
    required_evidence: 'Supplier license/GST/PAN review, batch/expiry traceability, prescription-control UAT, and pharmacist sign-off.',
  },
];

export const REQUIRED_EVIDENCE_CONTROL_CODES = REQUIRED_EVIDENCE_CONTROLS
  .map((control) => control.control_code);

export const ACCEPTED_EVIDENCE_STATUSES = new Set([
  'verified',
  'accepted_exception',
  'not_applicable',
]);

export const ABDM_CALLBACK_EVIDENCE_WINDOW_DAYS = 30;

export function evidenceAcceptanceIssues(row) {
  const status = String(row?.status || '').trim();
  if (!ACCEPTED_EVIDENCE_STATUSES.has(status)) return [];

  const issues = [];
  if (!hasText(row.evidence_uri)) issues.push('missing_evidence_uri');
  if (!hasText(row.verified_by)) issues.push('missing_verified_by');
  if (!hasText(row.verified_at)) issues.push('missing_verified_at');
  if ((status === 'accepted_exception' || status === 'not_applicable') && !hasText(row.notes)) {
    issues.push(`missing_${status}_notes`);
  }
  return issues;
}

export function abdmCallbackEvidenceIssues({
  signedRecent = 0,
  unsignedRecent = 0,
} = {}) {
  const issues = [];
  if (Number(signedRecent) <= 0) issues.push('missing_recent_signed_callback_event');
  if (Number(unsignedRecent) > 0) issues.push('unsigned_recent_callback_event');
  return issues;
}

export function makeEvidenceTemplate({ tenantId = DEFAULT_TENANT_ID } = {}) {
  return {
    generated_at: new Date().toISOString(),
    tenant_id: tenantId,
    accepted_status_requirements: {
      all_accepted_statuses: ['evidence_uri', 'verified_by', 'verified_at'],
      accepted_exception: ['notes'],
      not_applicable: ['notes'],
      accepted_statuses: [...ACCEPTED_EVIDENCE_STATUSES],
    },
    controls: REQUIRED_EVIDENCE_CONTROLS.map((control) => ({
      ...control,
      status: 'pending',
      evidence_uri: '',
      owner_uid: '',
      verified_by: '',
      verified_at: '',
      notes: '',
    })),
  };
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}
