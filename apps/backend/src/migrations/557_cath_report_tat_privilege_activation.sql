-- NL-13 P1b: cath-report turnaround time and active signing privilege.

CREATE INDEX IF NOT EXISTS idx_cath_procedure_reports_signed_tat
  ON cath_procedure_reports (tenant_id, case_id, signed_at DESC)
  WHERE status = 'signed';

CREATE INDEX IF NOT EXISTS idx_cath_procedure_logs_case_end
  ON cath_procedure_logs (tenant_id, case_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

CREATE OR REPLACE VIEW cath_report_tat_metrics
WITH (security_invoker = TRUE) AS
SELECT
  r.tenant_id,
  r.id AS report_id,
  r.case_id,
  r.procedure_log_id,
  r.patient_uid,
  r.encounter_id,
  r.report_type,
  r.status AS report_status,
  COALESCE(pl.ended_at, c.actual_end_at) AS procedure_ended_at,
  r.preliminary_at,
  r.signed_at,
  CASE
    WHEN COALESCE(pl.ended_at, c.actual_end_at) IS NOT NULL AND r.signed_at IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (r.signed_at - COALESCE(pl.ended_at, c.actual_end_at))) / 60)::integer
    ELSE NULL
  END AS procedure_to_signed_minutes,
  CASE
    WHEN COALESCE(pl.ended_at, c.actual_end_at) IS NOT NULL
      THEN ROUND(EXTRACT(EPOCH FROM (COALESCE(r.signed_at, NOW()) - COALESCE(pl.ended_at, c.actual_end_at))) / 60)::integer
    ELSE NULL
  END AS current_elapsed_minutes
FROM cath_procedure_reports r
JOIN cath_lab_cases c
  ON c.tenant_id = r.tenant_id
 AND c.id = r.case_id
LEFT JOIN cath_procedure_logs pl
  ON pl.tenant_id = r.tenant_id
 AND pl.id = r.procedure_log_id;

-- Migration 488 reserved an inert owner-supplied slot. The owner has now
-- confirmed the signing act and key, so preserve the existing catalog id when
-- possible and activate cath_report_signing for every tenant.
UPDATE privilege_catalog existing
   SET privilege_key = 'cath_report_signing',
       display_name = 'Cath report signing',
       description = 'May sign cath-lab procedure reports after local credentialing approval.',
       required_credential_types = ARRAY['registration', 'qualification', 'training']::text[],
       review_cadence_days = 365,
       enforcement_scope = 'cath_lab_reporting',
       status = 'active',
       metadata = existing.metadata || '{
         "owner_supplied": false,
         "placeholder": false,
         "optional_gate": false,
         "gate_enabled": true,
         "nl13_p1b": true
       }'::jsonb,
       updated_at = NOW()
 WHERE existing.privilege_key = 'cath_lab_owner_supplied_privilege'
   AND NOT EXISTS (
     SELECT 1
       FROM privilege_catalog confirmed
      WHERE confirmed.tenant_id = existing.tenant_id
        AND confirmed.privilege_key = 'cath_report_signing'
   );

WITH cath_report_privilege (
  privilege_key,
  display_name,
  description,
  required_credential_types,
  review_cadence_days,
  enforcement_scope,
  status,
  metadata
) AS (
  VALUES (
    'cath_report_signing',
    'Cath report signing',
    'May sign cath-lab procedure reports after local credentialing approval.',
    ARRAY['registration', 'qualification', 'training']::text[],
    365,
    'cath_lab_reporting',
    'active',
    '{"owner_supplied":false,"placeholder":false,"optional_gate":false,"gate_enabled":true,"nl13_p1b":true}'::jsonb
  )
)
INSERT INTO privilege_catalog (
  tenant_id,
  privilege_key,
  display_name,
  description,
  required_credential_types,
  review_cadence_days,
  enforcement_scope,
  status,
  metadata
)
SELECT
  t.id,
  p.privilege_key,
  p.display_name,
  p.description,
  p.required_credential_types,
  p.review_cadence_days,
  p.enforcement_scope,
  p.status,
  p.metadata
FROM tenants t
CROSS JOIN cath_report_privilege p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  status = 'active',
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

UPDATE staff_credentials credential
   SET privilege_catalog_id = confirmed.id,
       updated_at = NOW()
  FROM privilege_catalog placeholder
  JOIN privilege_catalog confirmed
    ON confirmed.tenant_id = placeholder.tenant_id
   AND confirmed.privilege_key = 'cath_report_signing'
 WHERE placeholder.privilege_key = 'cath_lab_owner_supplied_privilege'
   AND credential.tenant_id = placeholder.tenant_id
   AND credential.privilege_catalog_id = placeholder.id;

UPDATE privilege_catalog
   SET status = 'retired',
       metadata = metadata || '{"superseded_by":"cath_report_signing","gate_enabled":false}'::jsonb,
       updated_at = NOW()
 WHERE privilege_key = 'cath_lab_owner_supplied_privilege';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL13_P1B_CATH_REPORT_SIGNING_PRIVILEGE_ACTIVATED',
  'privilege_catalog',
  'cath_report_signing',
  jsonb_build_object(
    'migration', '557_cath_report_tat_privilege_activation.sql',
    'program', 'NL-13 P1b',
    'reason', 'Owner-confirmed cath-report signing privilege activated with fail-closed enforcement.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1
    FROM audit_logs
   WHERE action = 'NL13_P1B_CATH_REPORT_SIGNING_PRIVILEGE_ACTIVATED'
);
