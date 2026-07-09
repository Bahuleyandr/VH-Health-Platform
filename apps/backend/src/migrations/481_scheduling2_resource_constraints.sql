-- 481_scheduling2_resource_constraints.sql
--
-- NL8-P4: generic room/equipment compatibility and database-enforced
-- no-overlap for resource_bookings, mirroring the NL6-10 chair pattern.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookable_resources
  ADD COLUMN IF NOT EXISTS service_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS department_id INTEGER,
  ADD COLUMN IF NOT EXISTS capacity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE bookable_resources
  ADD CONSTRAINT chk_bookable_resources_capacity
  CHECK (capacity > 0) NOT VALID;

ALTER TABLE bookable_resources
  VALIDATE CONSTRAINT chk_bookable_resources_capacity;

CREATE TABLE IF NOT EXISTS scheduling_resource_compatibility (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  resource_id       INTEGER NOT NULL,
  template_id       INTEGER,
  doctor_id         INTEGER,
  appointment_type  VARCHAR(60),
  service_code      VARCHAR(80),
  visit_type        VARCHAR(40),
  requirement       VARCHAR(20) NOT NULL DEFAULT 'compatible',
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_scheduling_resource_compatibility_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_scheduling_resource_compatibility_resource
    FOREIGN KEY (resource_id) REFERENCES bookable_resources(id) ON DELETE CASCADE,
  CONSTRAINT fk_scheduling_resource_compatibility_template
    FOREIGN KEY (template_id) REFERENCES provider_availability_templates(id) ON DELETE CASCADE,
  CONSTRAINT chk_scheduling_resource_compatibility_requirement
    CHECK (requirement IN ('compatible', 'preferred', 'required'))
);

CREATE INDEX IF NOT EXISTS idx_scheduling_resource_compatibility_resource
  ON scheduling_resource_compatibility (tenant_id, resource_id, is_active);

CREATE INDEX IF NOT EXISTS idx_scheduling_resource_compatibility_lookup
  ON scheduling_resource_compatibility (
    tenant_id,
    resource_id,
    doctor_id,
    appointment_type,
    service_code,
    visit_type
  )
  WHERE is_active;

ALTER TABLE scheduling_resource_compatibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_resource_compatibility FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON scheduling_resource_compatibility;
CREATE POLICY tenant_isolation ON scheduling_resource_compatibility
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_resource_bookings_resource_no_overlap'
      AND conrelid = 'resource_bookings'::regclass
  ) THEN
    ALTER TABLE resource_bookings
      ADD CONSTRAINT excl_resource_bookings_resource_no_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      )
      WHERE (status = 'booked');
  END IF;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'NL8_P4_RESOURCE_CONSTRAINTS_APPLIED',
  'resource_bookings',
  'resource_bookings',
  jsonb_build_object(
    'migration', '481_scheduling2_resource_constraints.sql',
    'program', 'NL8-P4',
    'reason', 'Generic resource compatibility metadata and database-level no-overlap guard.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL8_P4_RESOURCE_CONSTRAINTS_APPLIED'
    AND resource = 'resource_bookings'
);

COMMIT;
