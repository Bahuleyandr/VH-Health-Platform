-- 417_ophthalmic_imaging_attachments.sql
--
-- N6-7 ophthalmology completion: R2/local-storage metadata for ophthalmic
-- imaging attachments keyed to an ophthalmic exam.

BEGIN;

CREATE TABLE IF NOT EXISTS ophthalmic_imaging_attachments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  exam_id INTEGER NOT NULL REFERENCES ophthalmic_exams(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  eye VARCHAR(2),
  image_type VARCHAR(40) NOT NULL DEFAULT 'other',
  storage_key TEXT NOT NULL,
  storage_url TEXT,
  mime_type VARCHAR(100) NOT NULL,
  file_size INTEGER,
  sha256_hash VARCHAR(64),
  captured_at TIMESTAMPTZ(6),
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_ophthalmic_imaging_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT chk_ophthalmic_imaging_eye CHECK (eye IS NULL OR eye IN ('od', 'os', 'ou')),
  CONSTRAINT chk_ophthalmic_imaging_type CHECK (
    image_type IN ('fundus', 'oct', 'visual_field', 'slit_lamp', 'biometry_scan', 'other')
  ),
  CONSTRAINT chk_ophthalmic_imaging_file_size CHECK (file_size IS NULL OR file_size > 0)
);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_imaging_exam
  ON ophthalmic_imaging_attachments (tenant_id, exam_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ophthalmic_imaging_patient
  ON ophthalmic_imaging_attachments (tenant_id, patient_uid, uploaded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ophthalmic_imaging_storage_key
  ON ophthalmic_imaging_attachments (tenant_id, storage_key);

ALTER TABLE ophthalmic_imaging_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ophthalmic_imaging_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ophthalmic_imaging_attachments;
CREATE POLICY tenant_isolation ON ophthalmic_imaging_attachments
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
  'OPHTHALMIC_IMAGING_ATTACHMENTS_APPLIED',
  'ophthalmic_imaging_attachments',
  '417',
  jsonb_build_object(
    'migration', '417_ophthalmic_imaging_attachments.sql',
    'scope', 'ophthalmic imaging attachment metadata keyed to exam and validated upload storage keys'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'OPHTHALMIC_IMAGING_ATTACHMENTS_APPLIED'
    AND resource = 'ophthalmic_imaging_attachments'
    AND resource_id = '417'
);

COMMIT;
