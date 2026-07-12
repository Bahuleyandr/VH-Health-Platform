-- Credential-hardening 2026-07-13: worked example of extending the credential
-- gate to a new specialty. Seeds an obstetrics privilege so labour-ward acts
-- (labour admission, delivery) can require the responsible obstetrician to hold
-- an active `obgyn_labour_ward_access` credential — mirroring how theatre gates
-- on the surgeon and radiation gates on the radiation-oncology privilege.
--
-- Grantable immediately (status='active' in the CATALOG = the privilege exists
-- and can be granted to staff). Runtime ENFORCEMENT is governed solely by the
-- env flag OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED (default OFF), so this is
-- additive and changes nothing until an operator enables it after credentialing
-- the obstetricians. NOTE: metadata.gate_enabled is a record of the owner's
-- activation decision, NOT a live runtime switch — the env flag is authoritative
-- (see src/config/privilegeGates.js).

BEGIN;

WITH obgyn_privilege (
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
    'obgyn_labour_ward_access',
    'OBGyn labour-ward access',
    'May act as the responsible obstetrician for labour-ward acts (labour admission, delivery) after local credentialing approval. Enforcement is env-flagged and stays off until the operator enables it after granting credentials.',
    ARRAY['registration', 'qualification', 'training']::text[],
    365,
    'obstetrics',
    'active',
    '{"owner_supplied":false,"placeholder":false,"optional_gate":true,"gate_enabled":false,"credential_hardening_2026_07_13":true}'::jsonb
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
CROSS JOIN obgyn_privilege p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  status = CASE
    WHEN privilege_catalog.status = 'active' THEN privilege_catalog.status
    ELSE EXCLUDED.status
  END,
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'CREDENTIAL_HARDENING_OBGYN_LABOUR_WARD_PRIVILEGE_SEEDED',
  'privilege_catalog',
  'obgyn_labour_ward_access',
  jsonb_build_object(
    'migration', '574_obgyn_labour_ward_privilege_seed.sql',
    'program', 'credential-hardening 2026-07-13',
    'reason', 'Worked-example specialty gate: obstetrics privilege seeded (grantable); runtime enforcement stays env-flagged off.'
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
   WHERE action = 'CREDENTIAL_HARDENING_OBGYN_LABOUR_WARD_PRIVILEGE_SEEDED'
);

COMMIT;
