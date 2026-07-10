BEGIN;

CREATE TABLE IF NOT EXISTS burn_reassessments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  burn_chart_id BIGINT NOT NULL REFERENCES burn_charts(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  reassessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reassessed_by UUID,
  wound_status VARCHAR(80),
  pain_score INTEGER CHECK (pain_score IS NULL OR (pain_score >= 0 AND pain_score <= 10)),
  infection_concern BOOLEAN NOT NULL DEFAULT false,
  perfusion_concern BOOLEAN NOT NULL DEFAULT false,
  procedure_notes TEXT,
  serial_assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_reassessments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_reassessments_serial_object
    CHECK (jsonb_typeof(serial_assessment) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_burn_reassessments_chart
  ON burn_reassessments (tenant_id, burn_chart_id, reassessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_burn_reassessments_patient
  ON burn_reassessments (tenant_id, patient_uid, reassessed_at DESC);

ALTER TABLE burn_reassessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_reassessments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_reassessments;
CREATE POLICY tenant_isolation ON burn_reassessments
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

CREATE TABLE IF NOT EXISTS burn_reassessment_media (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  reassessment_id BIGINT NOT NULL REFERENCES burn_reassessments(id) ON DELETE CASCADE,
  burn_chart_id BIGINT NOT NULL REFERENCES burn_charts(id) ON DELETE CASCADE,
  patient_uid UUID NOT NULL,
  media_storage_key TEXT NOT NULL,
  media_sha256_hash VARCHAR(64),
  mime_type VARCHAR(120),
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  captured_at TIMESTAMPTZ,
  captured_by UUID,
  consent_confirmed BOOLEAN NOT NULL DEFAULT false,
  media_kind VARCHAR(30) NOT NULL DEFAULT 'photo'
    CHECK (media_kind IN ('photo', 'document', 'diagram')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_burn_reassessment_media_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT chk_burn_reassessment_media_storage_key
    CHECK (NULLIF(TRIM(media_storage_key), '') IS NOT NULL),
  CONSTRAINT chk_burn_reassessment_media_hash
    CHECK (media_sha256_hash IS NULL OR media_sha256_hash ~ '^[A-Fa-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_burn_reassessment_media_reassessment
  ON burn_reassessment_media (tenant_id, reassessment_id);
CREATE INDEX IF NOT EXISTS idx_burn_reassessment_media_chart
  ON burn_reassessment_media (tenant_id, burn_chart_id, created_at DESC);

ALTER TABLE burn_reassessment_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_reassessment_media FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON burn_reassessment_media;
CREATE POLICY tenant_isolation ON burn_reassessment_media
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
