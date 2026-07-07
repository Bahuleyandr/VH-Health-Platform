-- N6-5: credential document proof, renewal fields, and persistent alerts.

BEGIN;

ALTER TABLE staff_credentials
  ADD COLUMN IF NOT EXISTS renewal_status VARCHAR(20) NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS renewal_requested_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS renewal_completed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS document_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS document_storage_url TEXT,
  ADD COLUMN IF NOT EXISTS document_mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS document_file_size INTEGER,
  ADD COLUMN IF NOT EXISTS document_sha256_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS document_uploaded_at TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_staff_credentials_renewal_status'
  ) THEN
    ALTER TABLE staff_credentials
      ADD CONSTRAINT chk_staff_credentials_renewal_status
      CHECK (renewal_status IN ('current', 'due', 'requested', 'in_review', 'renewed', 'not_required'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS credential_document_uploads (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  staff_credential_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  storage_key TEXT NOT NULL,
  storage_url TEXT,
  mime_type VARCHAR(100) NOT NULL,
  file_size INTEGER NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_credential_documents_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_credential_documents_credential
    FOREIGN KEY (staff_credential_id) REFERENCES staff_credentials(id) ON DELETE CASCADE,
  CONSTRAINT uq_credential_documents_version
    UNIQUE (tenant_id, staff_credential_id, version)
);

CREATE INDEX IF NOT EXISTS idx_credential_documents_staff
  ON credential_document_uploads (tenant_id, staff_uid, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_credential_documents_credential_latest
  ON credential_document_uploads (tenant_id, staff_credential_id, version DESC);

CREATE TABLE IF NOT EXISTS credential_expiry_alerts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  staff_credential_id INTEGER NOT NULL,
  staff_uid UUID NOT NULL,
  alert_kind VARCHAR(30) NOT NULL DEFAULT 'credential_expiry'
    CHECK (alert_kind IN ('credential_expiry', 'renewal_due')),
  due_date DATE NOT NULL,
  days_remaining INTEGER NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'cancelled')),
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ(6),
  resolution VARCHAR(120),
  resolved_at TIMESTAMPTZ(6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_credential_alerts_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_credential_alerts_credential
    FOREIGN KEY (staff_credential_id) REFERENCES staff_credentials(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_credential_alerts_open
  ON credential_expiry_alerts (tenant_id, staff_credential_id, alert_kind, due_date)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_credential_alerts_tenant_status
  ON credential_expiry_alerts (tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_credential_alerts_staff
  ON credential_expiry_alerts (tenant_id, staff_uid, status, due_date);

ALTER TABLE credential_document_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_document_uploads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON credential_document_uploads;
CREATE POLICY tenant_isolation ON credential_document_uploads
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

ALTER TABLE credential_expiry_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_expiry_alerts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON credential_expiry_alerts;
CREATE POLICY tenant_isolation ON credential_expiry_alerts
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
