-- N6-5: privilege catalog foundation.
-- Staff credential writes are staff-subject governance records, not patient
-- timeline events. This migration gives privilege rows a tenant-scoped catalog
-- anchor so clinical gates do not proliferate free-text names.

BEGIN;

CREATE TABLE IF NOT EXISTS privilege_catalog (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  privilege_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  description TEXT,
  required_credential_types TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  review_cadence_days INTEGER NOT NULL DEFAULT 365
    CHECK (review_cadence_days BETWEEN 1 AND 3650),
  enforcement_scope VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'retired')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_privilege_catalog_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT uq_privilege_catalog_key
    UNIQUE (tenant_id, privilege_key),
  CONSTRAINT chk_privilege_catalog_key_format
    CHECK (privilege_key ~ '^[a-z0-9][a-z0-9_]{1,118}[a-z0-9]$')
);

CREATE INDEX IF NOT EXISTS idx_privilege_catalog_tenant_status
  ON privilege_catalog (tenant_id, status, privilege_key);
CREATE INDEX IF NOT EXISTS idx_privilege_catalog_scope
  ON privilege_catalog (tenant_id, enforcement_scope)
  WHERE enforcement_scope IS NOT NULL;

ALTER TABLE staff_credentials
  ADD COLUMN IF NOT EXISTS privilege_catalog_id BIGINT,
  ADD COLUMN IF NOT EXISTS requested_by UUID,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS review_cadence_days INTEGER,
  ADD COLUMN IF NOT EXISTS renewal_due_at DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_staff_credentials_privilege_catalog'
  ) THEN
    ALTER TABLE staff_credentials
      ADD CONSTRAINT fk_staff_credentials_privilege_catalog
      FOREIGN KEY (privilege_catalog_id) REFERENCES privilege_catalog(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_staff_credentials_privilege_catalog
  ON staff_credentials (tenant_id, privilege_catalog_id, status)
  WHERE privilege_catalog_id IS NOT NULL;

ALTER TABLE privilege_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE privilege_catalog FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON privilege_catalog;
CREATE POLICY tenant_isolation ON privilege_catalog
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

ALTER TABLE staff_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON staff_credentials;
CREATE POLICY tenant_isolation ON staff_credentials
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

COMMIT;
