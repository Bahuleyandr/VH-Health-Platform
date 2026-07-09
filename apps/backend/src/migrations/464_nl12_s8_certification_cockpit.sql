-- 464_nl12_s8_certification_cockpit.sql
--
-- NL12-S8: evidence-row cockpit controls for ABDM M1-M3, VAPT,
-- ISO 27001, and SOC 2. These rows prepare the cockpit; they do not claim
-- external certification.

BEGIN;

WITH rows (control_code, control_area, control_name, metadata) AS (
  VALUES
    (
      'ABDM_M1_CERTIFICATION_SUITE',
      'ABDM',
      'ABDM M1 certification suite evidence accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"ABDM M1","runbook_uri":"docs/ABDM_READINESS.md","cert_ready_declaration":"internal_cert_ready_substrate","external_certification_status":"not_certified","engagement_status":"owner_credentials_required","blockers":["Owner ABDM sandbox credentials and bridge registration are not attached.","M1 certification-suite booking and result evidence are not accepted."],"supporting_controls":["ABDM_CALLBACK_AUTHENTICITY"]}}'::jsonb
    ),
    (
      'ABDM_M2_CERTIFICATION_SUITE',
      'ABDM',
      'ABDM M2 encrypted HIP data-push certification evidence accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"ABDM M2","runbook_uri":"docs/ABDM_READINESS.md","cert_ready_declaration":"internal_cert_ready_substrate","external_certification_status":"not_certified","engagement_status":"sandbox_dry_run_required","blockers":["Encrypted M2 sandbox dry-run evidence is not accepted.","M2 certification-suite run and NHA sign-off are not attached."],"supporting_controls":["ABDM_M2_ENCRYPTED_PUSH"]}}'::jsonb
    ),
    (
      'ABDM_M3_CERTIFICATION_SUITE',
      'ABDM',
      'ABDM M3 HIU consent-flow certification evidence accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"ABDM M3","runbook_uri":"docs/ABDM_READINESS.md","cert_ready_declaration":"internal_cert_ready_substrate","external_certification_status":"not_certified","engagement_status":"suite_booking_required","blockers":["HIU consent-flow UAT and certification-suite run are not attached.","External ABDM M3 acceptance evidence is not verified."],"supporting_controls":["ABDM_CALLBACK_AUTHENTICITY"]}}'::jsonb
    ),
    (
      'VAPT_OR_SIGNED_EXCEPTION',
      'SECURITY',
      'External VAPT report or signed exception accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"VAPT","runbook_uri":"docs/PENTEST_READINESS.md","cert_ready_declaration":"internal_cert_ready_package","external_certification_status":"not_certified","engagement_status":"external_firm_required","blockers":["External VAPT report, closure evidence, or signed high-risk exception is not accepted."],"supporting_controls":["SIEM_ALERTS_ONCALL"]}}'::jsonb
    ),
    (
      'ISO_27001_EXTERNAL_AUDIT',
      'ISO_SOC2',
      'ISO 27001 external audit engagement evidence accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"ISO 27001","runbook_uri":"docs/india-deployment-readiness.md","cert_ready_declaration":"internal_control_pack_ready","external_certification_status":"not_certified","engagement_status":"auditor_selection_required","blockers":["ISO 27001 auditor, engagement letter, control owners, and evidence cadence are not accepted."],"supporting_controls":["INDIA_LOG_RETENTION_180D","SIEM_ALERTS_ONCALL","IMAGE_SIGNATURE_ADMISSION"]}}'::jsonb
    ),
    (
      'SOC2_TYPE2_EXTERNAL_AUDIT',
      'ISO_SOC2',
      'SOC 2 Type II external audit engagement evidence accepted',
      '{"baseline":"nl12_s8_certification_cockpit","nl12_s8":{"stage":"SOC 2","runbook_uri":"docs/india-deployment-readiness.md","cert_ready_declaration":"internal_control_pack_ready","external_certification_status":"not_certified","engagement_status":"auditor_selection_required","blockers":["SOC 2 auditor, observation window, trust-services scope, and recurring evidence are not accepted."],"supporting_controls":["INDIA_LOG_RETENTION_180D","SIEM_ALERTS_ONCALL","IMAGE_SIGNATURE_ADMISSION"]}}'::jsonb
    )
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
  metadata,
  NOW(),
  NOW()
FROM rows
ON CONFLICT (tenant_id, control_code) DO UPDATE SET
  control_area = EXCLUDED.control_area,
  control_name = EXCLUDED.control_name,
  metadata = COALESCE(india_compliance_evidence.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL12_S8_CERTIFICATION_COCKPIT_SEEDED',
  'india_compliance_evidence',
  '464',
  jsonb_build_object(
    'migration', '464_nl12_s8_certification_cockpit.sql',
    'tracks', jsonb_build_array('ABDM_M1', 'ABDM_M2', 'ABDM_M3', 'VAPT', 'ISO_27001', 'SOC2_TYPE2'),
    'declaration_boundary', 'internal cert-ready is separate from externally certified'
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
   WHERE action = 'NL12_S8_CERTIFICATION_COCKPIT_SEEDED'
     AND resource = 'india_compliance_evidence'
     AND resource_id = '464'
);

COMMIT;
