-- 411_infusion_chairs.sql
--
-- NL6-10: oncology day-care infusion chair scheduling.
-- Chair resources are tenant-scoped per unit. Bookings arrive in migration 412.

BEGIN;

CREATE TABLE IF NOT EXISTS infusion_chairs (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  unit_name     VARCHAR(120) NOT NULL DEFAULT 'Day Care',
  chair_code    VARCHAR(40) NOT NULL,
  display_name  VARCHAR(120) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  location_note TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_infusion_chairs_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT uq_infusion_chairs_unit_code
    UNIQUE (tenant_id, unit_name, chair_code),
  CONSTRAINT chk_infusion_chairs_status
    CHECK (status IN ('active', 'maintenance', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_infusion_chairs_unit_status
  ON infusion_chairs (tenant_id, unit_name, status, chair_code);

ALTER TABLE infusion_chairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE infusion_chairs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON infusion_chairs;
CREATE POLICY tenant_isolation ON infusion_chairs
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

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'INFUSION_CHAIRS_APPLIED',
  'infusion_chairs',
  'infusion_chairs',
  jsonb_build_object(
    'migration', '411_infusion_chairs.sql',
    'program', 'NL6-10',
    'reason', 'Tenant-scoped oncology day-care infusion chair resources.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'INFUSION_CHAIRS_APPLIED'
    AND resource = 'infusion_chairs'
);

COMMIT;
