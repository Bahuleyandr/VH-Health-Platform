-- NL-13 P5: inert owner-supplied perfusion sign-off privilege catalog slot.

BEGIN;

WITH perfusion_privilege(privilege_key, display_name, description, required_credential_types, review_cadence_days, enforcement_scope, metadata) AS (
  VALUES (
    'ctvs_perfusionist_signoff_owner_supplied',
    'CTVS perfusionist sign-off (owner supplied)',
    'Inert placeholder for the owner-confirmed perfusionist sign-off privilege; enforcement remains disabled until operator confirmation.',
    ARRAY['registration', 'qualification']::text[],
    365,
    'ctvs_perfusion',
    '{"owner_confirmation_required": true, "inert_until_confirmed": true, "optional_gate": true, "source": "NL-13 P5"}'::jsonb
  )
)
INSERT INTO privilege_catalog (
  tenant_id, privilege_key, display_name, description, required_credential_types,
  review_cadence_days, enforcement_scope, metadata
)
SELECT
  t.id,
  p.privilege_key,
  p.display_name,
  p.description,
  p.required_credential_types,
  p.review_cadence_days,
  p.enforcement_scope,
  p.metadata
FROM tenants t
CROSS JOIN perfusion_privilege p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT 'NL13_P5_PERFUSION_PRIVILEGE_SLOT_SEEDED', 'privilege_catalog', 'ctvs_perfusionist_signoff_owner_supplied',
  jsonb_build_object(
    'migration', '545_perfusion_privilege_catalog_seed.sql',
    'program', 'NL-13 P5',
    'reason', 'Inert owner-supplied perfusionist sign-off privilege slot; enforcement remains flag-gated.'
  ),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action = 'NL13_P5_PERFUSION_PRIVILEGE_SLOT_SEEDED'
  );

COMMIT;
