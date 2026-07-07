-- NL-7 P3: calibration certificates linked to validated upload/storage paths.

CREATE TABLE IF NOT EXISTS biomed_calibration_certificates (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  biomed_device_id INTEGER NOT NULL REFERENCES clinical_ai_biomed_devices(id) ON DELETE CASCADE,
  work_order_id BIGINT REFERENCES biomed_work_orders(id) ON DELETE SET NULL,
  certificate_number VARCHAR(120) NOT NULL,
  calibrated_at TIMESTAMPTZ(6) NOT NULL,
  due_at TIMESTAMPTZ(6) NOT NULL,
  performed_by VARCHAR(160),
  performed_by_uid UUID,
  document_id TEXT NOT NULL,
  document_storage_key TEXT,
  document_mime_type VARCHAR(100),
  result VARCHAR(24) NOT NULL,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT biomed_calibration_certificates_result_check
    CHECK (result IN ('pass', 'fail', 'adjusted')),
  CONSTRAINT biomed_calibration_certificates_dates_check
    CHECK (due_at >= calibrated_at),
  CONSTRAINT biomed_calibration_certificates_number_not_blank
    CHECK (length(trim(certificate_number)) > 0),
  CONSTRAINT biomed_calibration_certificates_document_not_blank
    CHECK (length(trim(document_id)) > 0),
  CONSTRAINT fk_biomed_calibration_certificates_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_biomed_calibration_certificates_number
  ON biomed_calibration_certificates (tenant_id, certificate_number);

CREATE INDEX IF NOT EXISTS idx_biomed_calibration_certificates_device_due
  ON biomed_calibration_certificates (tenant_id, biomed_device_id, due_at DESC);

CREATE INDEX IF NOT EXISTS idx_biomed_calibration_certificates_order
  ON biomed_calibration_certificates (tenant_id, work_order_id);

ALTER TABLE biomed_calibration_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE biomed_calibration_certificates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON biomed_calibration_certificates;
CREATE POLICY tenant_isolation ON biomed_calibration_certificates
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
