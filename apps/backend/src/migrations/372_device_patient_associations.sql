-- NL-7 P1: audited device-to-patient associations.

CREATE TABLE IF NOT EXISTS device_patient_associations (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  device_registry_id INTEGER NOT NULL REFERENCES device_registry(id) ON DELETE CASCADE,
  channel VARCHAR(80) NOT NULL DEFAULT '',
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  bed_id INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  started_by UUID,
  start_method VARCHAR(20) NOT NULL,
  ended_at TIMESTAMPTZ(6),
  ended_by UUID,
  end_reason VARCHAR(40),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT device_patient_associations_start_method_check CHECK (start_method IN ('scan', 'manual', 'adt')),
  CONSTRAINT device_patient_associations_end_reason_check CHECK (
    end_reason IS NULL OR end_reason IN ('manual', 'device_reassigned', 'discharge', 'transfer', 'device_retired')
  ),
  CONSTRAINT device_patient_associations_end_after_start_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

ALTER TABLE device_patient_associations
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_patient_assoc_active_channel
  ON device_patient_associations (tenant_id, device_registry_id, channel)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_patient_assoc_active_patient
  ON device_patient_associations (tenant_id, patient_uid)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_patient_assoc_history_device
  ON device_patient_associations (tenant_id, device_registry_id, started_at DESC);

ALTER TABLE device_patient_associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_patient_associations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_patient_assoc_tenant_isolation ON device_patient_associations;
DROP POLICY IF EXISTS tenant_isolation ON device_patient_associations;
CREATE POLICY tenant_isolation ON device_patient_associations
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
