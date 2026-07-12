-- Sign-off group 2026-07-13: owner confirmed the radiation privilege gate is
-- CREDENTIAL-based (cath_report_signing pattern). Migration 512 reserved an
-- inert placeholder slot; this activates the confirmed key so grants can be
-- issued now. Runtime enforcement stays env-flagged
-- (RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED, default OFF) so role-based
-- access is unchanged until the operator flips it after credentialing staff.
-- Intended grantees: oncologists, medical physicists, radiotherapy nurses,
-- radiation oncologists; ADMIN/SUPER_ADMIN bypass at the service layer.

BEGIN;

-- Preserve the existing catalog id where possible: rename the placeholder in
-- place when no confirmed row exists yet for the tenant.
UPDATE privilege_catalog existing
   SET privilege_key = 'radiation_oncology_access',
       display_name = 'Radiation oncology clinical access',
       description = 'May perform credential-gated radiation-oncology acts: radiotherapy plan approval, fraction delivery attestation, and radioisotope administration. Intended grantees: oncologists, medical physicists, radiotherapy nurses, radiation oncologists. Enforcement is env-flagged and stays off until the operator enables it after granting credentials.',
       required_credential_types = ARRAY['registration', 'qualification', 'training']::text[],
       review_cadence_days = 365,
       enforcement_scope = 'radiation_oncology',
       status = 'active',
       metadata = existing.metadata || '{
         "owner_supplied": false,
         "placeholder": false,
         "optional_gate": true,
         "gate_enabled": false,
         "signoff_2026_07_13": true,
         "intended_grantees": ["oncologist", "medical_physicist", "radiotherapy_nurse", "radiation_oncologist"]
       }'::jsonb,
       updated_at = NOW()
 WHERE existing.privilege_key = 'radiation_oncology_owner_supplied_privilege'
   AND NOT EXISTS (
     SELECT 1
       FROM privilege_catalog confirmed
      WHERE confirmed.tenant_id = existing.tenant_id
        AND confirmed.privilege_key = 'radiation_oncology_access'
   );

WITH radiation_access_privilege (
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
    'radiation_oncology_access',
    'Radiation oncology clinical access',
    'May perform credential-gated radiation-oncology acts: radiotherapy plan approval, fraction delivery attestation, and radioisotope administration. Intended grantees: oncologists, medical physicists, radiotherapy nurses, radiation oncologists. Enforcement is env-flagged and stays off until the operator enables it after granting credentials.',
    ARRAY['registration', 'qualification', 'training']::text[],
    365,
    'radiation_oncology',
    'active',
    '{"owner_supplied":false,"placeholder":false,"optional_gate":true,"gate_enabled":false,"signoff_2026_07_13":true,"intended_grantees":["oncologist","medical_physicist","radiotherapy_nurse","radiation_oncologist"]}'::jsonb
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
CROSS JOIN radiation_access_privilege p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  status = 'active',
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

-- Any credential rows granted against the placeholder follow it to the
-- confirmed key.
UPDATE staff_credentials credential
   SET privilege_catalog_id = confirmed.id,
       updated_at = NOW()
  FROM privilege_catalog placeholder
  JOIN privilege_catalog confirmed
    ON confirmed.tenant_id = placeholder.tenant_id
   AND confirmed.privilege_key = 'radiation_oncology_access'
 WHERE placeholder.privilege_key = 'radiation_oncology_owner_supplied_privilege'
   AND credential.tenant_id = placeholder.tenant_id
   AND credential.privilege_catalog_id = placeholder.id;

UPDATE privilege_catalog
   SET status = 'retired',
       metadata = metadata || '{"superseded_by":"radiation_oncology_access","gate_enabled":false}'::jsonb,
       updated_at = NOW()
 WHERE privilege_key = 'radiation_oncology_owner_supplied_privilege';

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'SIGNOFF_RADIATION_ONCOLOGY_ACCESS_PRIVILEGE_ACTIVATED',
  'privilege_catalog',
  'radiation_oncology_access',
  jsonb_build_object(
    'migration', '572_radiation_oncology_privilege_activation.sql',
    'program', 'audit sign-off group 2026-07-13',
    'reason', 'Owner-confirmed credential-based radiation gate: catalog key activated for granting; runtime enforcement stays env-flagged off.'
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
   WHERE action = 'SIGNOFF_RADIATION_ONCOLOGY_ACCESS_PRIVILEGE_ACTIVATED'
);

COMMIT;
