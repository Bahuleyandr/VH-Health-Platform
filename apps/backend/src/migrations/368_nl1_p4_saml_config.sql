-- 368_nl1_p4_saml_config.sql
--
-- NL-1 P4: SAML 2.0 compatibility provider configuration and durable
-- multi-replica replay/request cache. Existing P1 rows reserved the basic
-- SAML columns; P4 adds imported metadata, SP entity/cert material, IdP
-- signing certificate rollover, validation policy, and replay persistence.

BEGIN;

ALTER TABLE tenant_identity_providers
  ADD COLUMN IF NOT EXISTS saml_sp_entity_id text,
  ADD COLUMN IF NOT EXISTS saml_sso_url text,
  ADD COLUMN IF NOT EXISTS saml_metadata_xml_ciphertext text,
  ADD COLUMN IF NOT EXISTS saml_idp_signing_certs_ciphertext text,
  ADD COLUMN IF NOT EXISTS saml_signing_cert_ciphertext text,
  ADD COLUMN IF NOT EXISTS saml_decryption_cert_ciphertext text,
  ADD COLUMN IF NOT EXISTS saml_nameid_format text,
  ADD COLUMN IF NOT EXISTS saml_require_signed_response boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS saml_require_signed_assertion boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS saml_encrypted_assertions boolean NOT NULL DEFAULT false;

ALTER TABLE tenant_identity_providers
  DROP CONSTRAINT IF EXISTS tenant_identity_providers_saml_required_chk;
ALTER TABLE tenant_identity_providers
  ADD CONSTRAINT tenant_identity_providers_saml_required_chk
  CHECK (
    status <> 'active'
    OR protocol <> 'saml'
    OR (
      saml_entity_id IS NOT NULL
      AND saml_sp_entity_id IS NOT NULL
      AND saml_acs_url IS NOT NULL
      AND saml_idp_signing_certs_ciphertext IS NOT NULL
    )
  );

ALTER TABLE tenant_identity_providers
  DROP CONSTRAINT IF EXISTS tenant_identity_providers_saml_encryption_chk;
ALTER TABLE tenant_identity_providers
  ADD CONSTRAINT tenant_identity_providers_saml_encryption_chk
  CHECK (
    protocol <> 'saml'
    OR saml_encrypted_assertions = false
    OR saml_decryption_key_ciphertext IS NOT NULL
  );

CREATE TABLE IF NOT EXISTS identity_saml_replay_cache (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NULL,
  realm          varchar(20) NOT NULL,
  provider_id    bigint NOT NULL,
  cache_kind     varchar(24) NOT NULL,
  cache_key      text NOT NULL,
  cache_value    text,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_saml_replay_cache_realm_chk
    CHECK (realm IN ('admin', 'staff')),
  CONSTRAINT identity_saml_replay_cache_kind_chk
    CHECK (cache_kind IN ('request', 'response', 'assertion', 'relay_state')),
  CONSTRAINT identity_saml_replay_cache_tenant_platform_chk
    CHECK (tenant_id IS NOT NULL OR realm = 'admin')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_identity_saml_replay_cache_tenant') THEN
    ALTER TABLE identity_saml_replay_cache
      ADD CONSTRAINT fk_identity_saml_replay_cache_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_identity_saml_replay_cache_provider') THEN
    ALTER TABLE identity_saml_replay_cache
      ADD CONSTRAINT fk_identity_saml_replay_cache_provider
      FOREIGN KEY (provider_id) REFERENCES tenant_identity_providers(id) ON UPDATE NO ACTION ON DELETE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_identity_saml_replay_cache_key
  ON identity_saml_replay_cache (provider_id, cache_kind, cache_key);
CREATE INDEX IF NOT EXISTS idx_identity_saml_replay_cache_expiry
  ON identity_saml_replay_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_identity_saml_replay_cache_tenant_provider
  ON identity_saml_replay_cache (tenant_id, provider_id, cache_kind);

ALTER TABLE identity_saml_replay_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_saml_replay_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity_saml_replay_cache;
CREATE POLICY tenant_isolation ON identity_saml_replay_cache
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
