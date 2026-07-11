-- NL-13 P4: inert radiation-oncology privilege catalog slot.
-- The actual operator privilege key and enforcement decision are owner-sourced;
-- this placeholder remains paused/off until a tenant replaces or activates it.
-- The service wires the gate (radioisotope administration) but it fails closed
-- until the owner supplies the real key and enables the gate.

BEGIN;

WITH radiation_privilege(privilege_key, display_name, description, required_credential_types, review_cadence_days, enforcement_scope, status, metadata) AS (
  VALUES (
    'radiation_oncology_owner_supplied_privilege',
    'Radiation oncology owner-supplied privilege',
    'Placeholder slot for an operator-confirmed radiation-oncology / radioisotope-administration privilege. Enforcement stays disabled until the owner supplies the real key and enables the gate.',
    ARRAY['registration', 'qualification', 'training']::text[],
    365,
    'radiation_oncology',
    'paused',
    '{"owner_supplied": true, "placeholder": true, "optional_gate": true, "gate_enabled": false, "nl13_p4": true}'::jsonb
  )
)
INSERT INTO privilege_catalog (
  tenant_id, privilege_key, display_name, description, required_credential_types,
  review_cadence_days, enforcement_scope, status, metadata
)
SELECT
  t.id, p.privilege_key, p.display_name, p.description,
  p.required_credential_types, p.review_cadence_days, p.enforcement_scope, p.status, p.metadata
FROM tenants t
CROSS JOIN radiation_privilege p
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
SELECT 'NL13_P4_RADIATION_ONCOLOGY_PRIVILEGE_SLOT_SEEDED', 'privilege_catalog', 'radiation_oncology_owner_supplied_privilege',
  jsonb_build_object(
    'migration', '512_radiation_oncology_privilege_seed.sql',
    'program', 'NL-13 P4',
    'reason', 'Inert owner-sourced radiation-oncology / radioisotope-administration privilege slot.'
  ),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action = 'NL13_P4_RADIATION_ONCOLOGY_PRIVILEGE_SLOT_SEEDED'
  );

COMMIT;
