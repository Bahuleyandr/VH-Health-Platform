-- NL-13 P1: cath-lab links to active NL-7 device-patient associations.

CREATE TABLE IF NOT EXISTS cath_device_links (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  procedure_log_id BIGINT REFERENCES cath_procedure_logs(id) ON DELETE SET NULL,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  device_patient_association_id INTEGER NOT NULL REFERENCES device_patient_associations(id) ON DELETE RESTRICT,
  link_type VARCHAR(50) NOT NULL DEFAULT 'summary',
  external_system VARCHAR(160),
  external_accession_id VARCHAR(160),
  inbound_document_id VARCHAR(160),
  summary TEXT,
  attached_by UUID,
  attached_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_cath_device_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT cath_device_links_type_check
    CHECK (link_type IN ('hemodynamic_summary', 'angiography_accession', 'ep_system', 'tavr_device', 'dose_document', 'summary', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_device_links_assoc_per_case
  ON cath_device_links (tenant_id, case_id, device_patient_association_id, link_type);

CREATE INDEX IF NOT EXISTS idx_cath_device_links_patient
  ON cath_device_links (tenant_id, patient_uid, attached_at DESC);

ALTER TABLE cath_device_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_device_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON cath_device_links;
CREATE POLICY tenant_isolation ON cath_device_links
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
