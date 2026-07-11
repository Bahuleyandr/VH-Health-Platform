-- NL-13 P5: Perfusion device/vendor-document links through NL-7 associations.

CREATE TABLE IF NOT EXISTS perfusion_device_links (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  perfusion_record_id INTEGER NOT NULL REFERENCES perfusion_records(id) ON DELETE CASCADE,
  device_patient_association_id INTEGER NOT NULL REFERENCES device_patient_associations(id) ON DELETE RESTRICT,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  vendor_document_ref TEXT,
  vendor_source_label VARCHAR(180),
  vendor_source_version VARCHAR(80),
  summary_import_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  imported_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_perfusion_device_links_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT perfusion_device_links_import_status_check
    CHECK (summary_import_status IN ('pending', 'owner_supplied', 'summarized', 'rejected', 'not_applicable')),
  CONSTRAINT perfusion_device_links_imported_summary_object
    CHECK (jsonb_typeof(imported_summary) = 'object'),
  CONSTRAINT perfusion_device_links_attachment_refs_array
    CHECK (jsonb_typeof(attachment_refs) = 'array'),
  UNIQUE (tenant_id, perfusion_record_id, device_patient_association_id)
);

CREATE INDEX IF NOT EXISTS idx_perfusion_device_links_record
  ON perfusion_device_links (tenant_id, perfusion_record_id);

CREATE INDEX IF NOT EXISTS idx_perfusion_device_links_patient
  ON perfusion_device_links (tenant_id, patient_uid, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_active_perfusion_device_association()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM device_patient_associations dpa
     WHERE dpa.id = NEW.device_patient_association_id
       AND dpa.tenant_id = NEW.tenant_id
       AND dpa.patient_uid = NEW.patient_uid
       AND dpa.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'perfusion_device_links require an active NL-7 device_patient_associations row for the same tenant and patient'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_perfusion_device_links_active_assoc ON perfusion_device_links;
CREATE TRIGGER trg_perfusion_device_links_active_assoc
  BEFORE INSERT OR UPDATE OF tenant_id, patient_uid, device_patient_association_id
  ON perfusion_device_links
  FOR EACH ROW
  EXECUTE FUNCTION enforce_active_perfusion_device_association();

ALTER TABLE perfusion_device_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfusion_device_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON perfusion_device_links;
CREATE POLICY tenant_isolation ON perfusion_device_links
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
