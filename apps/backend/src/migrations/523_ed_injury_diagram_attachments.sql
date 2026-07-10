-- NL-14 P2: injury diagram and chain-of-custody attachment metadata.
-- Blobs remain in the existing media/R2 store; this table stores metadata only.

BEGIN;

CREATE TABLE IF NOT EXISTS ed_injury_diagram_attachments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  mlc_record_id INTEGER REFERENCES mlc_records(id) ON DELETE CASCADE,
  trauma_survey_record_id BIGINT REFERENCES trauma_survey_records(id) ON DELETE CASCADE,
  emergency_visit_id INTEGER REFERENCES emergency_visits(id) ON DELETE SET NULL,
  patient_uid UUID REFERENCES users(uid) ON DELETE RESTRICT,
  attachment_kind VARCHAR(40) NOT NULL,
  storage_key TEXT NOT NULL,
  storage_url TEXT,
  mime_type VARCHAR(100) NOT NULL,
  file_size INTEGER NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  uploaded_by_uid UUID,
  uploaded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  chain_of_custody_step VARCHAR(80),
  custodian_uid UUID,
  sealed_at TIMESTAMPTZ(6),
  received_at TIMESTAMPTZ(6),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_event_id UUID REFERENCES clinical_audit_events(id) ON DELETE SET NULL,
  CONSTRAINT ed_injury_attachments_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT ed_injury_attachments_kind_check CHECK (
    attachment_kind IN ('injury_diagram', 'wound_photo', 'chain_of_custody', 'police_document', 'other')
  ),
  CONSTRAINT ed_injury_attachments_parent_check CHECK (
    mlc_record_id IS NOT NULL OR trauma_survey_record_id IS NOT NULL
  ),
  CONSTRAINT ed_injury_attachments_file_size_check CHECK (file_size > 0),
  CONSTRAINT ed_injury_attachments_hash_check CHECK (length(sha256_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_ed_injury_attachments_mlc
  ON ed_injury_diagram_attachments (tenant_id, mlc_record_id, uploaded_at DESC)
  WHERE mlc_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ed_injury_attachments_survey
  ON ed_injury_diagram_attachments (tenant_id, trauma_survey_record_id, uploaded_at DESC)
  WHERE trauma_survey_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ed_injury_attachments_patient
  ON ed_injury_diagram_attachments (tenant_id, patient_uid, uploaded_at DESC)
  WHERE patient_uid IS NOT NULL;

ALTER TABLE ed_injury_diagram_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ed_injury_diagram_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ed_injury_diagram_attachments;
CREATE POLICY tenant_isolation ON ed_injury_diagram_attachments
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

COMMIT;
