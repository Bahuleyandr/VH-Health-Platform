-- NL-6 N6-2 BB-A: donor-subject immutable consent capture.

BEGIN;

CREATE TABLE IF NOT EXISTS donor_consents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  donor_id INTEGER NOT NULL,
  consent_type VARCHAR(40) NOT NULL DEFAULT 'blood_donation',
  consent_version INTEGER NOT NULL DEFAULT 1,
  consent_statement TEXT NOT NULL,
  consent_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_key TEXT,
  storage_url TEXT,
  mime_type VARCHAR(100),
  file_size INTEGER,
  sha256_hash VARCHAR(64) NOT NULL,
  captured_by UUID,
  captured_by_role VARCHAR(60),
  signer_name VARCHAR(160),
  signer_uid UUID,
  captured_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fk_donor_consents_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE NO ACTION,
  CONSTRAINT fk_donor_consents_donor
    FOREIGN KEY (donor_id) REFERENCES donors(id) ON DELETE CASCADE,
  CONSTRAINT chk_donor_consents_type
    CHECK (consent_type IN ('blood_donation', 'screening', 'apheresis', 'camp')),
  CONSTRAINT chk_donor_consents_hash
    CHECK (sha256_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_donor_consents_version
  ON donor_consents (tenant_id, donor_id, consent_type, consent_version);

CREATE INDEX IF NOT EXISTS idx_donor_consents_donor_latest
  ON donor_consents (tenant_id, donor_id, consent_type, consent_version DESC);

CREATE OR REPLACE FUNCTION prevent_donor_consent_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'donor_consents are immutable; capture a new version instead'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_donor_consents_no_update ON donor_consents;
CREATE TRIGGER trg_donor_consents_no_update
  BEFORE UPDATE ON donor_consents
  FOR EACH ROW EXECUTE FUNCTION prevent_donor_consent_mutation();

ALTER TABLE donor_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE donor_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON donor_consents;
CREATE POLICY tenant_isolation ON donor_consents
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
