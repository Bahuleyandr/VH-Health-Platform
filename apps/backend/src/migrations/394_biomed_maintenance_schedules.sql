-- NL-7 P3: CMMS maintenance schedules and registry contract metadata.

ALTER TABLE clinical_ai_biomed_devices
  ADD COLUMN IF NOT EXISTS amc_vendor VARCHAR(160),
  ADD COLUMN IF NOT EXISTS amc_contract_number VARCHAR(120),
  ADD COLUMN IF NOT EXISTS amc_starts_on DATE,
  ADD COLUMN IF NOT EXISTS amc_expires_on DATE,
  ADD COLUMN IF NOT EXISTS amc_contact_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS amc_contact_phone VARCHAR(40);

CREATE TABLE IF NOT EXISTS biomed_maintenance_schedules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  biomed_device_id INTEGER NOT NULL REFERENCES clinical_ai_biomed_devices(id) ON DELETE CASCADE,
  kind VARCHAR(24) NOT NULL,
  interval_days INTEGER,
  interval_usage_hours NUMERIC(12,2),
  next_due_at TIMESTAMPTZ(6),
  next_due_usage_hours NUMERIC(12,2),
  assigned_role VARCHAR(60) NOT NULL DEFAULT 'BIOMEDICAL_STAFF',
  assigned_to_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_uid UUID,
  assigned_vendor VARCHAR(160),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_materialized_due_at TIMESTAMPTZ(6),
  last_materialized_usage_hours NUMERIC(12,2),
  last_work_order_id BIGINT,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT biomed_maintenance_schedules_kind_check
    CHECK (kind IN ('preventive', 'calibration', 'inspection')),
  CONSTRAINT biomed_maintenance_schedules_interval_check
    CHECK (
      interval_days IS NOT NULL
      OR interval_usage_hours IS NOT NULL
    ),
  CONSTRAINT fk_biomed_maintenance_schedules_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_biomed_maintenance_schedules_due
  ON biomed_maintenance_schedules (tenant_id, active, next_due_at)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_biomed_maintenance_schedules_device
  ON biomed_maintenance_schedules (tenant_id, biomed_device_id, active);

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_maintenance_schedules_active_kind
  ON biomed_maintenance_schedules (tenant_id, biomed_device_id, kind)
  WHERE active = TRUE;

ALTER TABLE biomed_maintenance_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE biomed_maintenance_schedules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON biomed_maintenance_schedules;
CREATE POLICY tenant_isolation ON biomed_maintenance_schedules
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
