-- NL-13 P6: transplant privilege catalog seeds.

BEGIN;

WITH transplant_privileges(privilege_key, display_name, description, required_credential_types, review_cadence_days, enforcement_scope, metadata) AS (
  VALUES
    ('transplant_surgeon', 'Transplant surgeon', 'May perform or sign transplant surgical clinical acts after credentialing approval.', ARRAY['registration', 'qualification', 'privilege']::text[], 365, 'transplant', '{"adopted_default": true, "nl13_p6": true}'::jsonb),
    ('transplant_physician', 'Transplant physician', 'May create and manage transplant candidate, waitlist, and immunosuppression clinical acts.', ARRAY['registration', 'qualification', 'privilege']::text[], 365, 'transplant', '{"adopted_default": true, "nl13_p6": true}'::jsonb),
    ('transplant_coordinator', 'Transplant coordinator', 'May coordinate donor referrals and owner-reviewed NOTTO export evidence.', ARRAY['registration', 'training', 'privilege']::text[], 365, 'transplant', '{"adopted_default": true, "nl13_p6": true}'::jsonb),
    ('transplant_committee_member', 'Transplant committee member', 'May record transplant committee decisions under local operator-supplied quorum policy.', ARRAY['registration', 'qualification', 'privilege']::text[], 365, 'transplant', '{"adopted_default": true, "nl13_p6": true}'::jsonb)
)
INSERT INTO privilege_catalog (
  tenant_id, privilege_key, display_name, description, required_credential_types,
  review_cadence_days, enforcement_scope, metadata
)
SELECT
  t.id, p.privilege_key, p.display_name, p.description,
  p.required_credential_types, p.review_cadence_days, p.enforcement_scope, p.metadata
FROM tenants t
CROSS JOIN transplant_privileges p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT 'NL13_P6_TRANSPLANT_PRIVILEGES_SEEDED', 'privilege_catalog', 'transplant_privileges',
  jsonb_build_object(
    'migration', '554_transplant_privilege_catalog_seed.sql',
    'program', 'NL-13 P6',
    'reason', 'Owner-confirmed transplant clinical-act privilege catalog.'
  ),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action = 'NL13_P6_TRANSPLANT_PRIVILEGES_SEEDED'
  );

COMMIT;
