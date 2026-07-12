-- 576_audit_retention_policy_baseline.sql
--
-- Evidence-safe retention baseline for every SQL audit sink consumed by the
-- accountability workspace. Archive is the safe default: the runtime sweep
-- does not erase archive policies, and it also fails closed for policies that
-- require a legal-hold decision until subject-aware hold handling exists.

BEGIN;

WITH retention_rows (
  policy_code,
  applies_to_table,
  display_name,
  retention_days,
  action,
  basis,
  metadata
) AS (
  VALUES
    (
      'INDIA_HTTP_AUDIT_RETENTION',
      'audit_log',
      'HTTP request audit retention',
      365,
      'archive',
      'CERT-In security-event traceability and hospital privacy investigation evidence.',
      '{"audit_sink":"request","minimum_days":180}'::jsonb
    ),
    (
      'INDIA_AUDIT_LOGS_RETENTION',
      'audit_logs',
      'Application audit log retention',
      365,
      'archive',
      'CERT-In security-event traceability and hospital privacy investigation evidence.',
      '{"audit_sink":"operational","minimum_days":180}'::jsonb
    ),
    (
      'INDIA_CLINICAL_AUDIT_RETENTION',
      'clinical_audit_events',
      'Tamper-evident clinical audit retention',
      3650,
      'archive',
      'Medico-legal, clinical-safety, and NABH evidence retention.',
      '{"audit_sink":"clinical","hash_chained":true}'::jsonb
    ),
    (
      'INDIA_HIPAA_ACCESS_RETENTION',
      'hipaa_access_log',
      'PHI access audit retention',
      2555,
      'archive',
      'Privacy, access-control, breach-investigation, and patient-rights evidence retention.',
      '{"audit_sink":"phi_access"}'::jsonb
    ),
    (
      'INDIA_PATIENT_ACCESS_AUDIT_RETENTION',
      'patient_access_audit_log',
      'Patient access-decision audit retention',
      2555,
      'archive',
      'Care-team, denial, and break-glass access-decision evidence retention.',
      '{"audit_sink":"patient_access","break_glass_evidence":true}'::jsonb
    )
)
INSERT INTO data_retention_policies (
  tenant_id,
  policy_code,
  applies_to_table,
  display_name,
  description,
  retention_days,
  action,
  basis,
  legal_hold_aware,
  data_processing_activity_id,
  status,
  metadata,
  created_at,
  updated_at
)
SELECT
  tenant.id,
  retention.policy_code,
  retention.applies_to_table,
  retention.display_name,
  'Platform audit-evidence baseline. Archive and legal-hold decisions must be implemented before destructive retention is enabled.',
  retention.retention_days,
  retention.action,
  retention.basis,
  true,
  activity.id,
  'active',
  retention.metadata || '{"baseline":"audit_retention_576","archive_required_before_delete":true}'::jsonb,
  NOW(),
  NOW()
FROM tenants tenant
CROSS JOIN retention_rows retention
LEFT JOIN data_processing_activities activity
  ON activity.tenant_id = tenant.id
 AND activity.activity_code = 'INDIA_AUDIT_SECURITY'
ON CONFLICT (tenant_id, applies_to_table) DO UPDATE SET
  retention_days = GREATEST(
    data_retention_policies.retention_days,
    EXCLUDED.retention_days
  ),
  metadata = COALESCE(data_retention_policies.metadata, '{}'::jsonb)
    || EXCLUDED.metadata
    || jsonb_build_object(
      'baseline_floor_applied', true,
      'existing_action_preserved', data_retention_policies.action
    ),
  updated_at = NOW();

COMMIT;
