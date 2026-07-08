-- NL11-S3: Entitlement Packaging P1 - tenant assignment and audit trail.
-- tenant_id uses the migration-356 GUC-aware default; service writes still pass
-- tenant_id explicitly so accidental default-tenant stamping is avoided.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_entitlements (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  package_key     VARCHAR(80) NOT NULL REFERENCES product_packages(package_key) ON DELETE RESTRICT,
  status          VARCHAR(30) NOT NULL DEFAULT 'active',
  starts_at       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ(6),
  grace_ends_at   TIMESTAMPTZ(6),
  source          VARCHAR(60) NOT NULL DEFAULT 'manual',
  assigned_by     UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT tenant_entitlements_status_check
    CHECK (status IN ('active', 'grace', 'expired', 'suspended', 'cancelled')),
  CONSTRAINT tenant_entitlements_window_check
    CHECK (expires_at IS NULL OR expires_at >= starts_at),
  CONSTRAINT fk_tenant_entitlements_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_entitlements_tenant_package
  ON tenant_entitlements (tenant_id, package_key);

CREATE INDEX IF NOT EXISTS idx_tenant_entitlements_tenant_status
  ON tenant_entitlements (tenant_id, status, expires_at);

ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_entitlements;
CREATE POLICY tenant_isolation ON tenant_entitlements
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

CREATE TABLE IF NOT EXISTS entitlement_audit_events (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  feature_key      VARCHAR(120) REFERENCES product_features(feature_key) ON DELETE SET NULL,
  package_key      VARCHAR(80) REFERENCES product_packages(package_key) ON DELETE SET NULL,
  action           VARCHAR(80) NOT NULL,
  decision         VARCHAR(40) NOT NULL,
  enforcement_mode VARCHAR(30),
  surface          VARCHAR(60),
  route_path       TEXT,
  actor_uid        UUID,
  actor_role       VARCHAR(80),
  request_id       VARCHAR(100),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT entitlement_audit_events_decision_check
    CHECK (decision IN ('allow', 'deny', 'grace', 'status_only', 'audit_only')),
  CONSTRAINT fk_entitlement_audit_events_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entitlement_audit_events_tenant_created
  ON entitlement_audit_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entitlement_audit_events_feature_created
  ON entitlement_audit_events (feature_key, created_at DESC);

ALTER TABLE entitlement_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON entitlement_audit_events;
CREATE POLICY tenant_isolation ON entitlement_audit_events
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

INSERT INTO tenant_entitlements
  (tenant_id, package_key, status, starts_at, source, metadata)
SELECT
  t.id,
  'enterprise',
  'active',
  NOW(),
  'migration_434',
  jsonb_build_object(
    'reason', 'Preserve existing tenant access when entitlement enforcement is introduced.',
    'migration', '434_tenant_entitlements_and_audit.sql'
  )
FROM tenants t
ON CONFLICT (tenant_id, package_key) DO NOTHING;

INSERT INTO entitlement_audit_events
  (tenant_id, package_key, action, decision, enforcement_mode, surface, metadata, created_at)
SELECT
  t.id,
  'enterprise',
  'TENANT_ENTITLEMENT_GRANTED',
  'allow',
  'hard_block',
  'migration',
  jsonb_build_object(
    'migration', '434_tenant_entitlements_and_audit.sql',
    'reason', 'Existing tenant enterprise entitlement seed'
  ),
  NOW()
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM entitlement_audit_events e
  WHERE e.tenant_id = t.id
    AND e.package_key = 'enterprise'
    AND e.action = 'TENANT_ENTITLEMENT_GRANTED'
    AND e.surface = 'migration'
);

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'TENANT_ENTITLEMENTS_APPLIED',
  'tenant_entitlements',
  'nl11_s3_entitlements',
  jsonb_build_object(
    'migration', '434_tenant_entitlements_and_audit.sql',
    'program', 'NL11-S3',
    'seeded_package', 'enterprise',
    'seeded_tenants', (SELECT COUNT(*) FROM tenant_entitlements WHERE source = 'migration_434')
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'TENANT_ENTITLEMENTS_APPLIED'
    AND resource_id = 'nl11_s3_entitlements'
);

COMMIT;
