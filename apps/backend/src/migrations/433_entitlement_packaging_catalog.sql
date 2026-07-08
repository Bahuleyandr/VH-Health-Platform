-- NL11-S3: Entitlement Packaging P1 - package catalog and feature contract.
-- Global catalog only; tenant-specific assignment/audit lands in migration 434.

BEGIN;

CREATE TABLE IF NOT EXISTS product_features (
  feature_key         VARCHAR(120) PRIMARY KEY,
  display_name        VARCHAR(160) NOT NULL,
  description         TEXT,
  category            VARCHAR(60) NOT NULL,
  enforcement_mode    VARCHAR(30) NOT NULL DEFAULT 'hard_block',
  urgent_clinical     BOOLEAN NOT NULL DEFAULT FALSE,
  route_patterns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  nav_surfaces        JSONB NOT NULL DEFAULT '[]'::jsonb,
  mobile_surface_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT product_features_enforcement_mode_check
    CHECK (enforcement_mode IN ('hard_block', 'status_only', 'audit_only'))
);

CREATE TABLE IF NOT EXISTS product_packages (
  package_key       VARCHAR(80) PRIMARY KEY,
  display_name      VARCHAR(160) NOT NULL,
  description       TEXT,
  package_tier      VARCHAR(40) NOT NULL DEFAULT 'standard',
  status            VARCHAR(30) NOT NULL DEFAULT 'active',
  grace_period_days INTEGER NOT NULL DEFAULT 14,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT product_packages_status_check
    CHECK (status IN ('active', 'deprecated', 'hidden')),
  CONSTRAINT product_packages_grace_period_check
    CHECK (grace_period_days >= 0 AND grace_period_days <= 90)
);

CREATE TABLE IF NOT EXISTS product_package_features (
  package_key VARCHAR(80) NOT NULL REFERENCES product_packages(package_key) ON DELETE CASCADE,
  feature_key VARCHAR(120) NOT NULL REFERENCES product_features(feature_key) ON DELETE CASCADE,
  included    BOOLEAN NOT NULL DEFAULT TRUE,
  limits      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (package_key, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_product_features_category
  ON product_features(category, feature_key);

CREATE INDEX IF NOT EXISTS idx_product_features_mobile_surfaces
  ON product_features USING GIN(mobile_surface_keys);

CREATE INDEX IF NOT EXISTS idx_product_package_features_feature
  ON product_package_features(feature_key);

INSERT INTO product_features
  (feature_key, display_name, description, category, enforcement_mode, urgent_clinical, route_patterns, nav_surfaces, mobile_surface_keys, metadata)
VALUES
  (
    'clinical.emergency',
    'Emergency care',
    'SOS, emergency triage, and urgent clinical care surfaces. Entitlement gaps are visible and audited but never hard-blocked.',
    'clinical',
    'status_only',
    TRUE,
    '["/api/v1/sos", "/api/v1/ed"]'::jsonb,
    '["staff.emergency", "patient.sos"]'::jsonb,
    ARRAY['patient.sos','staff.emergency']::TEXT[],
    '{"care_policy":"never_hard_block"}'::jsonb
  ),
  (
    'clinical.core',
    'Core clinical workspace',
    'EMR, orders, prescriptions, appointments, beds, and other care-delivery surfaces.',
    'clinical',
    'status_only',
    FALSE,
    '["/api/v1/clinical", "/api/v1/emr", "/api/v1/appointments", "/api/v1/beds"]'::jsonb,
    '["staff.clinical", "patient.records"]'::jsonb,
    ARRAY['patient.records','staff.clinical_workspace']::TEXT[],
    '{}'::jsonb
  ),
  (
    'mobile.patient_portal',
    'Patient mobile portal',
    'Patient app navigation and self-service capability manifest.',
    'mobile',
    'status_only',
    FALSE,
    '["/api/v1/portal", "/api/v1/users", "/api/v1/records"]'::jsonb,
    '["patient.mobile"]'::jsonb,
    ARRAY['patient.app']::TEXT[],
    '{}'::jsonb
  ),
  (
    'mobile.staff_workbench',
    'Staff mobile workbench',
    'Staff app dashboard, workbench, and role-driven navigation capability manifest.',
    'mobile',
    'status_only',
    FALSE,
    '["/api/v1/staff", "/api/v1/clinical-inbox"]'::jsonb,
    '["staff.mobile"]'::jsonb,
    ARRAY['staff.app']::TEXT[],
    '{}'::jsonb
  ),
  (
    'admin.operations',
    'Admin operations',
    'Operational admin portal surfaces that are commercial package features.',
    'admin',
    'hard_block',
    FALSE,
    '["/api/v1/admin"]'::jsonb,
    '["admin.operations"]'::jsonb,
    ARRAY[]::TEXT[],
    '{}'::jsonb
  ),
  (
    'admin.feature_flags',
    'Release switchboard',
    'Feature-flag control plane and package-sensitive release switches.',
    'admin',
    'hard_block',
    FALSE,
    '["/api/v1/admin/feature-flags"]'::jsonb,
    '["admin.feature_flags"]'::jsonb,
    ARRAY[]::TEXT[],
    '{}'::jsonb
  ),
  (
    'developer.api_clients',
    'Developer API clients',
    'API-client registration, key lifecycle, and partner integration management.',
    'developer',
    'hard_block',
    FALSE,
    '["/api/v1/admin/api-clients"]'::jsonb,
    '["admin.api_clients"]'::jsonb,
    ARRAY[]::TEXT[],
    '{}'::jsonb
  ),
  (
    'commercial.billing_packages',
    'Commercial billing packages',
    'Billing-master packages, day-care packages, and commercial configuration surfaces.',
    'commercial',
    'hard_block',
    FALSE,
    '["/api/v1/admin/billing-masters/packages"]'::jsonb,
    '["admin.billing_packages"]'::jsonb,
    ARRAY[]::TEXT[],
    '{}'::jsonb
  )
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enforcement_mode = EXCLUDED.enforcement_mode,
  urgent_clinical = EXCLUDED.urgent_clinical,
  route_patterns = EXCLUDED.route_patterns,
  nav_surfaces = EXCLUDED.nav_surfaces,
  mobile_surface_keys = EXCLUDED.mobile_surface_keys,
  metadata = product_features.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO product_packages
  (package_key, display_name, description, package_tier, grace_period_days, metadata)
VALUES
  (
    'foundation_clinical',
    'Foundation Clinical',
    'Core care delivery plus patient and staff mobile access.',
    'foundation',
    14,
    '{"sku":"VH-FOUNDATION-CLINICAL"}'::jsonb
  ),
  (
    'growth_admin',
    'Growth Admin',
    'Foundation clinical package with routine admin operations and billing package management.',
    'growth',
    14,
    '{"sku":"VH-GROWTH-ADMIN"}'::jsonb
  ),
  (
    'developer_platform',
    'Developer Platform',
    'Partner API-client lifecycle and integration packaging add-on.',
    'addon',
    7,
    '{"sku":"VH-DEVELOPER-PLATFORM"}'::jsonb
  ),
  (
    'enterprise',
    'Enterprise',
    'Full VH Health commercial package for existing tenants and enterprise pilots.',
    'enterprise',
    30,
    '{"sku":"VH-ENTERPRISE"}'::jsonb
  )
ON CONFLICT (package_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  package_tier = EXCLUDED.package_tier,
  grace_period_days = EXCLUDED.grace_period_days,
  metadata = product_packages.metadata || EXCLUDED.metadata,
  updated_at = NOW();

INSERT INTO product_package_features (package_key, feature_key, included, limits)
VALUES
  ('foundation_clinical', 'clinical.emergency', TRUE, '{}'::jsonb),
  ('foundation_clinical', 'clinical.core', TRUE, '{}'::jsonb),
  ('foundation_clinical', 'mobile.patient_portal', TRUE, '{}'::jsonb),
  ('foundation_clinical', 'mobile.staff_workbench', TRUE, '{}'::jsonb),
  ('growth_admin', 'clinical.emergency', TRUE, '{}'::jsonb),
  ('growth_admin', 'clinical.core', TRUE, '{}'::jsonb),
  ('growth_admin', 'mobile.patient_portal', TRUE, '{}'::jsonb),
  ('growth_admin', 'mobile.staff_workbench', TRUE, '{}'::jsonb),
  ('growth_admin', 'admin.operations', TRUE, '{}'::jsonb),
  ('growth_admin', 'commercial.billing_packages', TRUE, '{}'::jsonb),
  ('developer_platform', 'developer.api_clients', TRUE, '{}'::jsonb),
  ('enterprise', 'clinical.emergency', TRUE, '{}'::jsonb),
  ('enterprise', 'clinical.core', TRUE, '{}'::jsonb),
  ('enterprise', 'mobile.patient_portal', TRUE, '{}'::jsonb),
  ('enterprise', 'mobile.staff_workbench', TRUE, '{}'::jsonb),
  ('enterprise', 'admin.operations', TRUE, '{}'::jsonb),
  ('enterprise', 'admin.feature_flags', TRUE, '{}'::jsonb),
  ('enterprise', 'developer.api_clients', TRUE, '{}'::jsonb),
  ('enterprise', 'commercial.billing_packages', TRUE, '{}'::jsonb)
ON CONFLICT (package_key, feature_key) DO UPDATE SET
  included = EXCLUDED.included,
  limits = product_package_features.limits || EXCLUDED.limits;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'ENTITLEMENT_CATALOG_APPLIED',
  'product_features',
  'nl11_s3_catalog',
  jsonb_build_object(
    'migration', '433_entitlement_packaging_catalog.sql',
    'program', 'NL11-S3',
    'features', (SELECT COUNT(*) FROM product_features),
    'packages', (SELECT COUNT(*) FROM product_packages)
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'ENTITLEMENT_CATALOG_APPLIED'
    AND resource_id = 'nl11_s3_catalog'
);

COMMIT;
