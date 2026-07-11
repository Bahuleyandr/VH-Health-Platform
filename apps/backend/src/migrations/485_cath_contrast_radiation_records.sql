-- NL-13 P1: cath-lab contrast, fluoroscopy, and owner-sourced AERB evidence slots.

CREATE TABLE IF NOT EXISTS cath_contrast_radiation_records (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  contrast_agent VARCHAR(160),
  contrast_volume_ml NUMERIC(10,2),
  fluoroscopy_time_min NUMERIC(10,2),
  dose_area_product_gy_cm2 NUMERIC(12,3),
  air_kerma_mgy NUMERIC(12,3),
  dose_document_ref TEXT,
  dose_document_storage_key TEXT,
  aerb_evidence_owner VARCHAR(160),
  aerb_source_name VARCHAR(160),
  aerb_source_version VARCHAR(80),
  aerb_evidence_attachment_ref TEXT,
  equipment_qa_reference TEXT,
  recorded_by UUID,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_contrast_radiation_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_contrast_radiation_nonnegative_check
    CHECK (
      (contrast_volume_ml IS NULL OR contrast_volume_ml >= 0)
      AND (fluoroscopy_time_min IS NULL OR fluoroscopy_time_min >= 0)
      AND (dose_area_product_gy_cm2 IS NULL OR dose_area_product_gy_cm2 >= 0)
      AND (air_kerma_mgy IS NULL OR air_kerma_mgy >= 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_cath_contrast_case
  ON cath_contrast_radiation_records (tenant_id, case_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_cath_contrast_patient
  ON cath_contrast_radiation_records (tenant_id, patient_uid, recorded_at DESC);

ALTER TABLE cath_contrast_radiation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_contrast_radiation_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_contrast_radiation_records;
CREATE POLICY tenant_isolation ON cath_contrast_radiation_records
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
