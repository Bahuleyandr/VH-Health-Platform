-- NL-4: immutable e-consent signature capture.
-- Patient/staff-witness signature images live in R2/local storage; this table
-- keeps the tenant-scoped consent linkage, versioning, and audit metadata.

ALTER TABLE portal_proxy_grants
  ADD COLUMN IF NOT EXISTS signature_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS signature_storage_url TEXT,
  ADD COLUMN IF NOT EXISTS signature_mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS signature_file_size INTEGER,
  ADD COLUMN IF NOT EXISTS signature_sha256_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS signature_captured_at TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS consent_signatures (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  consent_id INTEGER NOT NULL,
  patient_uid UUID NOT NULL,
  signature_role VARCHAR(30) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  storage_key TEXT NOT NULL,
  storage_url TEXT,
  mime_type VARCHAR(100) NOT NULL,
  file_size INTEGER NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  captured_by UUID,
  captured_by_role VARCHAR(60),
  signer_name VARCHAR(160),
  signer_uid UUID,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT consent_signatures_role_check
    CHECK (signature_role IN ('patient', 'staff_witness')),
  CONSTRAINT fk_consent_signatures_consent
    FOREIGN KEY (consent_id) REFERENCES patient_consents(id) ON DELETE CASCADE,
  CONSTRAINT fk_consent_signatures_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_consent_signatures_version
  ON consent_signatures (tenant_id, consent_id, signature_role, version);

CREATE INDEX IF NOT EXISTS idx_consent_signatures_consent_latest
  ON consent_signatures (tenant_id, consent_id, signature_role, version DESC);

CREATE INDEX IF NOT EXISTS idx_consent_signatures_patient
  ON consent_signatures (tenant_id, patient_uid, captured_at DESC);

ALTER TABLE consent_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_signatures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON consent_signatures;
CREATE POLICY tenant_isolation ON consent_signatures
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
