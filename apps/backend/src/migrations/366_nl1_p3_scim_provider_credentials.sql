-- 366_nl1_p3_scim_provider_credentials.sql
--
-- NL-1 P3: SCIM is a tenant/provider-scoped provisioning surface attached to
-- the tenant IdP configuration row. SCIM credentials are stored as hashes, not
-- human JWTs, and SCIM mutations audit through identity_audit_events.

BEGIN;

ALTER TABLE tenant_identity_providers
  ADD COLUMN IF NOT EXISTS scim_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scim_bearer_token_hash char(64),
  ADD COLUMN IF NOT EXISTS scim_bearer_token_hint varchar(16),
  ADD COLUMN IF NOT EXISTS scim_token_rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS scim_last_authenticated_at timestamptz,
  ADD COLUMN IF NOT EXISTS scim_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenant_identity_providers
  DROP CONSTRAINT IF EXISTS tenant_identity_providers_scim_token_chk;
ALTER TABLE tenant_identity_providers
  ADD CONSTRAINT tenant_identity_providers_scim_token_chk
  CHECK (
    scim_enabled = false
    OR (
      tenant_id IS NOT NULL
      AND is_platform_provider = false
      AND scim_bearer_token_hash ~ '^[a-f0-9]{64}$'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_identity_providers_scim_endpoint
  ON tenant_identity_providers (tenant_id, provider_key)
  WHERE tenant_id IS NOT NULL AND scim_enabled = true;

CREATE INDEX IF NOT EXISTS idx_tenant_identity_providers_scim_lookup
  ON tenant_identity_providers (tenant_id, provider_key, status)
  WHERE scim_enabled = true;

ALTER TABLE identity_audit_events
  DROP CONSTRAINT IF EXISTS identity_audit_events_protocol_chk;
ALTER TABLE identity_audit_events
  ADD CONSTRAINT identity_audit_events_protocol_chk
  CHECK (protocol IN ('oidc', 'saml', 'scim'));

COMMIT;
