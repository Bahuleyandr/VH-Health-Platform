-- N6-5: privilege catalog adopted defaults and approval guardrails.

BEGIN;

WITH default_privileges(privilege_key, display_name, description, required_credential_types, review_cadence_days, enforcement_scope, metadata) AS (
  VALUES
    ('chemo_administration', 'Chemo administration', 'May administer chemotherapy cycles after two-person verification.', ARRAY['registration', 'training']::text[], 365, 'oncology', '{"adopted_default": true}'::jsonb),
    ('primary_surgeon', 'Primary surgeon', 'May be booked as the primary surgeon and sign operative readiness.', ARRAY['registration', 'qualification']::text[], 365, 'theatre', '{"adopted_default": true}'::jsonb),
    ('anesthesia_finalize', 'Anaesthesia finalization', 'May finalize anaesthesia records for surgical cases.', ARRAY['registration', 'qualification']::text[], 365, 'theatre', '{"adopted_default": true, "role_hint": "ANESTHETIST"}'::jsonb),
    ('endoscopy', 'Endoscopy', 'May perform endoscopy procedures under local governance.', ARRAY['registration', 'training']::text[], 365, 'procedure', '{"adopted_default": true}'::jsonb),
    ('icu_attending', 'ICU attending', 'May be assigned as the attending clinician for ICU governance surfaces.', ARRAY['registration', 'qualification']::text[], 365, 'icu', '{"adopted_default": true}'::jsonb),
    ('controlled_substance_prescribe', 'Controlled-substance prescribing', 'May prescribe controlled substances when the optional gate is enabled.', ARRAY['registration', 'training']::text[], 180, 'pharmacy', '{"adopted_default": true, "optional_gate": true}'::jsonb),
    ('radiology_subspecialty_ct', 'Radiology subspecialty - CT', 'May sign or govern CT subspecialty workflows.', ARRAY['registration', 'qualification']::text[], 365, 'radiology', '{"adopted_default": true, "subspecialty": "ct"}'::jsonb),
    ('radiology_subspecialty_mri', 'Radiology subspecialty - MRI', 'May sign or govern MRI subspecialty workflows.', ARRAY['registration', 'qualification']::text[], 365, 'radiology', '{"adopted_default": true, "subspecialty": "mri"}'::jsonb),
    ('radiology_subspecialty_interventional', 'Radiology subspecialty - interventional', 'May sign or govern interventional radiology workflows.', ARRAY['registration', 'qualification']::text[], 365, 'radiology', '{"adopted_default": true, "subspecialty": "interventional"}'::jsonb)
)
INSERT INTO privilege_catalog (
  tenant_id, privilege_key, display_name, description, required_credential_types,
  review_cadence_days, enforcement_scope, metadata
)
SELECT
  t.id, p.privilege_key, p.display_name, p.description,
  p.required_credential_types, p.review_cadence_days, p.enforcement_scope, p.metadata
FROM tenants t
CROSS JOIN default_privileges p
ON CONFLICT (tenant_id, privilege_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  required_credential_types = EXCLUDED.required_credential_types,
  review_cadence_days = EXCLUDED.review_cadence_days,
  enforcement_scope = EXCLUDED.enforcement_scope,
  metadata = privilege_catalog.metadata || EXCLUDED.metadata,
  updated_at = NOW();

UPDATE staff_credentials c
SET privilege_catalog_id = pc.id,
    review_cadence_days = COALESCE(c.review_cadence_days, pc.review_cadence_days),
    renewal_due_at = COALESCE(
      c.renewal_due_at,
      CASE
        WHEN c.valid_until IS NOT NULL THEN c.valid_until - (pc.review_cadence_days * INTERVAL '1 day')
        ELSE NULL
      END
    )
FROM privilege_catalog pc
WHERE c.tenant_id = pc.tenant_id
  AND c.credential_type = 'privilege'
  AND c.privilege_catalog_id IS NULL
  AND (
    lower(regexp_replace(c.name, '[^a-zA-Z0-9]+', '_', 'g')) = pc.privilege_key
    OR (
      lower(regexp_replace(c.name, '[^a-zA-Z0-9]+', '_', 'g')) = 'chemo_administer'
      AND pc.privilege_key = 'chemo_administration'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_credential_privilege_approval
  ON approvals (tenant_id, approval_kind, subject_resource_type, subject_resource_id)
  WHERE approval_kind = 'credential_privilege_grant'
    AND status = 'pending'
    AND subject_resource_id IS NOT NULL;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT 'N6_5_PRIVILEGE_CATALOG_SEEDED', 'privilege_catalog', 'privilege_catalog',
  jsonb_build_object(
    'migration', '380_privilege_catalog_seed_and_approval_indexes.sql',
    'program', 'N6-5',
    'reason', 'Credentialing and privileging catalog, approval, renewal, alert, and inert enforcement seams.'
  ),
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'audit_logs')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE action = 'N6_5_PRIVILEGE_CATALOG_SEEDED'
  );

COMMIT;
