-- 338_tenant_interop_secrets.sql
--
-- W3 (multi-tenancy program) WS6 — per-tenant inbound interop secrets.
--
-- ABDM and HL7 inbound callbacks are HMAC-signed. Today the verifying secret is a
-- single global env var (ABDM_CALLBACK_SECRET / HL7_INBOUND_SHARED_SECRET) shared
-- by every hospital. This table holds the secret PER TENANT, keyed by a
-- sender_identifier the caller presents BEFORE the HMAC check (ABDM: x-hip-id
-- header; HL7: MSH-4 sending facility). The route resolves the tenant from the
-- sender_identifier, then verifies the signature with THAT tenant's secret — so
-- tenant A's secret can never authenticate a callback aimed at tenant B. An
-- unresolved sender is rejected (no global fallback).
--
-- secret_ciphertext = encryptField(secret) (enc:v2 envelope). (kind,
-- sender_identifier) is GLOBALLY unique so a sender maps to exactly one tenant.
-- The default tenant's rows are seeded from the current env secrets by
-- scripts/seed-default-interop-secrets.mjs, so single-tenant operation is
-- unchanged. Mirrors the teleconsult_provider_configs encrypted-config pattern.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_interop_secrets (
  id                serial PRIMARY KEY,
  tenant_id         uuid NOT NULL DEFAULT
    COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid
    ),
  kind              varchar(40)  NOT NULL,   -- 'abdm_callback' | 'hl7_inbound'
  sender_identifier varchar(255) NOT NULL,   -- ABDM HIP id | HL7 MSH-4 sending facility
  secret_ciphertext text         NOT NULL,   -- encryptField(secret)
  status            varchar(20)  NOT NULL DEFAULT 'active',
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenant_interop_secrets_tenant') THEN
    ALTER TABLE tenant_interop_secrets
      ADD CONSTRAINT fk_tenant_interop_secrets_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

-- A sender identifier maps to exactly ONE tenant (pre-HMAC tenant resolution).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_interop_secrets_kind_sender
  ON tenant_interop_secrets (kind, sender_identifier);
CREATE INDEX IF NOT EXISTS idx_tenant_interop_secrets_tenant_id
  ON tenant_interop_secrets (tenant_id);

ALTER TABLE tenant_interop_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_interop_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_interop_secrets;
CREATE POLICY tenant_isolation ON tenant_interop_secrets
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
