-- 359_nhcx_messages.sql
--
-- NL-2 P1 NHCX eligibility + preauth core.
--
-- This table is only an exchange envelope. It deliberately links to the
-- tpa_claims / insurance_preauth / insurance_policies spine and never probes
-- or consolidates billing-side insurance_claims. Ledger behavior is out of
-- scope for P1.

BEGIN;

CREATE TABLE IF NOT EXISTS nhcx_messages (
  id                            BIGSERIAL PRIMARY KEY,
  tenant_id                     UUID NOT NULL DEFAULT
    COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ),
  environment                   VARCHAR(20) NOT NULL
    CHECK (environment IN ('sandbox', 'production')),
  direction                     VARCHAR(20) NOT NULL
    CHECK (direction IN ('outbound', 'inbound')),
  cycle                         VARCHAR(30) NOT NULL
    CHECK (cycle IN ('eligibility', 'preauth', 'claim', 'communication', 'task', 'payment_notice')),
  endpoint                      VARCHAR(120) NOT NULL,
  participant_code_self         VARCHAR(255) NOT NULL,
  participant_code_counterparty VARCHAR(255),
  hcx_api_call_id               VARCHAR(120),
  hcx_correlation_id            VARCHAR(120),
  hcx_workflow_id               VARCHAR(120),
  hcx_status                    VARCHAR(80),
  claim_id                      INTEGER REFERENCES tpa_claims(id) ON UPDATE NO ACTION ON DELETE SET NULL,
  preauth_id                    INTEGER REFERENCES insurance_preauth(id) ON UPDATE NO ACTION ON DELETE SET NULL,
  policy_id                     INTEGER REFERENCES insurance_policies(id) ON UPDATE NO ACTION ON DELETE SET NULL,
  patient_uid                   UUID,
  admission_id                  INTEGER,
  domain_resource_type          VARCHAR(80),
  profile_url                   TEXT,
  profile_version               VARCHAR(40),
  payload_hash                  VARCHAR(128) NOT NULL,
  protected_headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_ciphertext            TEXT,
  signature_verified            BOOLEAN NOT NULL DEFAULT false,
  registry_key_id               VARCHAR(160),
  certificate_thumbprint        VARCHAR(160),
  validation_issues             JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                        VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'accepted', 'sent', 'processed', 'duplicate',
      'failed', 'dead', 'rejected', 'manual_review'
    )),
  attempt_count                 INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error                    TEXT,
  next_retry_at                 TIMESTAMPTZ,
  received_at                   TIMESTAMPTZ,
  sent_at                       TIMESTAMPTZ,
  processed_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nhcx_messages_tenant') THEN
    ALTER TABLE nhcx_messages
      ADD CONSTRAINT fk_nhcx_messages_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_nhcx_messages_api_call
  ON nhcx_messages (tenant_id, hcx_api_call_id, environment);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_nhcx_messages_correlation_payload
  ON nhcx_messages (
    tenant_id,
    hcx_correlation_id,
    endpoint,
    direction,
    payload_hash,
    environment
  );

CREATE INDEX IF NOT EXISTS idx_nhcx_messages_tenant_status
  ON nhcx_messages (tenant_id, status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_nhcx_messages_preauth
  ON nhcx_messages (preauth_id, created_at DESC) WHERE preauth_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nhcx_messages_claim
  ON nhcx_messages (claim_id, created_at DESC) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nhcx_messages_policy
  ON nhcx_messages (policy_id, created_at DESC) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nhcx_messages_patient
  ON nhcx_messages (patient_uid, created_at DESC) WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nhcx_messages_correlation
  ON nhcx_messages (tenant_id, hcx_correlation_id, created_at DESC)
  WHERE hcx_correlation_id IS NOT NULL;

ALTER TABLE nhcx_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE nhcx_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON nhcx_messages;
CREATE POLICY tenant_isolation ON nhcx_messages
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
