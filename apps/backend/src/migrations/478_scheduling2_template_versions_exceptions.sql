-- 478_scheduling2_template_versions_exceptions.sql
--
-- NL8-P4: Scheduling 2.0 provider-template versioning and exceptions.
-- Extends the existing provider_availability_templates substrate instead of
-- creating a parallel scheduling system.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE provider_availability_templates
  ADD COLUMN IF NOT EXISTS template_group_uid UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS appointment_type VARCHAR(60),
  ADD COLUMN IF NOT EXISTS service_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS visit_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS room_resource_id INTEGER,
  ADD COLUMN IF NOT EXISTS counter_location VARCHAR(120),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE provider_availability_templates
  ADD CONSTRAINT chk_provider_availability_status
  CHECK (status IN ('draft', 'active', 'superseded', 'retired')) NOT VALID;

ALTER TABLE provider_availability_templates
  VALIDATE CONSTRAINT chk_provider_availability_status;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_provider_availability_room_resource'
      AND conrelid = 'provider_availability_templates'::regclass
  ) THEN
    ALTER TABLE provider_availability_templates
      ADD CONSTRAINT fk_provider_availability_room_resource
      FOREIGN KEY (room_resource_id) REFERENCES bookable_resources(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_provider_availability_template_version'
      AND conrelid = 'provider_availability_templates'::regclass
  ) THEN
    ALTER TABLE provider_availability_templates
      ADD CONSTRAINT uq_provider_availability_template_version
      UNIQUE (tenant_id, template_group_uid, version);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_provider_availability_group_active
  ON provider_availability_templates (tenant_id, template_group_uid, status, version DESC);

CREATE INDEX IF NOT EXISTS idx_provider_availability_service
  ON provider_availability_templates (tenant_id, doctor_id, appointment_type, service_code, visit_type)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS provider_availability_template_exceptions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  template_id     INTEGER REFERENCES provider_availability_templates(id) ON DELETE CASCADE,
  doctor_id       INTEGER NOT NULL,
  exception_date  DATE NOT NULL,
  exception_type  VARCHAR(20) NOT NULL,
  all_day         BOOLEAN NOT NULL DEFAULT false,
  start_time      TIME,
  end_time        TIME,
  slot_minutes    INTEGER,
  location        VARCHAR(120),
  reason          VARCHAR(240),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by      UUID,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_provider_template_exceptions_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_provider_template_exceptions_type
    CHECK (exception_type IN ('closed', 'blocked', 'modified', 'extra')),
  CONSTRAINT chk_provider_template_exceptions_status
    CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT chk_provider_template_exceptions_slot
    CHECK (slot_minutes IS NULL OR slot_minutes BETWEEN 5 AND 120),
  CONSTRAINT chk_provider_template_exceptions_window
    CHECK (
      all_day
      OR start_time IS NULL
      OR end_time IS NULL
      OR end_time > start_time
    )
);

CREATE INDEX IF NOT EXISTS idx_provider_template_exceptions_doctor_day
  ON provider_availability_template_exceptions (tenant_id, doctor_id, exception_date, status);

CREATE INDEX IF NOT EXISTS idx_provider_template_exceptions_template
  ON provider_availability_template_exceptions (tenant_id, template_id, exception_date DESC);

ALTER TABLE provider_availability_template_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_availability_template_exceptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON provider_availability_template_exceptions;
CREATE POLICY tenant_isolation ON provider_availability_template_exceptions
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

CREATE TABLE IF NOT EXISTS provider_availability_template_audit (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  template_id   INTEGER,
  action        VARCHAR(40) NOT NULL,
  changed_by    UUID,
  before_state  JSONB,
  after_state   JSONB,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_provider_template_audit_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_provider_template_audit_template
    FOREIGN KEY (template_id) REFERENCES provider_availability_templates(id) ON DELETE SET NULL,
  CONSTRAINT chk_provider_template_audit_action
    CHECK (action IN ('created', 'versioned', 'retired', 'exception_created', 'exception_cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_provider_template_audit_template
  ON provider_availability_template_audit (tenant_id, template_id, created_at DESC);

ALTER TABLE provider_availability_template_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_availability_template_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON provider_availability_template_audit;
CREATE POLICY tenant_isolation ON provider_availability_template_audit
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
  'NL8_P4_TEMPLATE_VERSIONS_APPLIED',
  'provider_availability_templates',
  'provider_availability_templates',
  jsonb_build_object(
    'migration', '478_scheduling2_template_versions_exceptions.sql',
    'program', 'NL8-P4',
    'reason', 'Versioned provider availability templates, exceptions, and audit evidence.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'NL8_P4_TEMPLATE_VERSIONS_APPLIED'
    AND resource = 'provider_availability_templates'
);

COMMIT;
