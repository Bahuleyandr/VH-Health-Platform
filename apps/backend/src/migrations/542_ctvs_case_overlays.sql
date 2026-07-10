-- NL-13 P5: CTVS theatre-case overlays.

CREATE TABLE IF NOT EXISTS ctvs_case_overlays (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  ot_schedule_id INTEGER NOT NULL REFERENCES ot_schedules(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL REFERENCES users(uid) ON DELETE RESTRICT,
  anesthesia_record_id INTEGER REFERENCES anesthesia_records(id) ON DELETE SET NULL,
  procedure_category VARCHAR(80) NOT NULL,
  bypass_expected BOOLEAN NOT NULL DEFAULT FALSE,
  blood_product_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  implant_device_readiness JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_owner_uid UUID REFERENCES users(uid) ON DELETE SET NULL,
  policy_source_label VARCHAR(180),
  policy_source_version VARCHAR(80),
  source_document_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(uid) ON DELETE SET NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ctvs_case_overlays_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT ctvs_case_overlays_category_not_blank
    CHECK (length(trim(procedure_category)) > 0),
  CONSTRAINT ctvs_case_overlays_blood_ready_object
    CHECK (jsonb_typeof(blood_product_readiness) = 'object'),
  CONSTRAINT ctvs_case_overlays_implant_ready_object
    CHECK (jsonb_typeof(implant_device_readiness) = 'object'),
  CONSTRAINT ctvs_case_overlays_source_refs_array
    CHECK (jsonb_typeof(source_document_refs) = 'array'),
  CONSTRAINT ctvs_case_overlays_attachment_refs_array
    CHECK (jsonb_typeof(attachment_refs) = 'array'),
  UNIQUE (tenant_id, ot_schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_ctvs_case_overlays_patient
  ON ctvs_case_overlays (tenant_id, patient_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ctvs_case_overlays_anesthesia
  ON ctvs_case_overlays (tenant_id, anesthesia_record_id)
  WHERE anesthesia_record_id IS NOT NULL;

ALTER TABLE ctvs_case_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE ctvs_case_overlays FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ctvs_case_overlays;
CREATE POLICY tenant_isolation ON ctvs_case_overlays
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
