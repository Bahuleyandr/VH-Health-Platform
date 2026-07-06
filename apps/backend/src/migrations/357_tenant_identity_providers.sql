-- 357_tenant_identity_providers.sql
--
-- NL-1 P1 — ADMIN realm OIDC SSO foundation.
--
-- Provider configuration is tenant-owned and encrypted at rest. The only
-- tenant-null provider rows are explicit platform ADMIN providers that may map
-- to SUPER_ADMIN; all tenant providers remain tenant-scoped and RLS-protected.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_identity_providers (
  id                              bigserial PRIMARY KEY,
  tenant_id                       uuid NULL,
  is_platform_provider            boolean NOT NULL DEFAULT false,
  realm                           varchar(20) NOT NULL,
  protocol                        varchar(20) NOT NULL,
  provider_key                    varchar(80) NOT NULL,
  display_name                    varchar(200) NOT NULL,
  status                          varchar(20) NOT NULL DEFAULT 'draft',
  oidc_issuer                     text,
  oidc_discovery_url              text,
  oidc_jwks_uri                   text,
  oidc_authorization_endpoint     text,
  oidc_token_endpoint             text,
  oidc_userinfo_endpoint          text,
  oidc_client_id                  text,
  oidc_client_secret_ciphertext   text,
  saml_entity_id                  text,
  saml_metadata_url               text,
  saml_acs_url                    text,
  saml_signing_key_ciphertext     text,
  saml_decryption_key_ciphertext  text,
  group_claim_name                varchar(120) NOT NULL DEFAULT 'groups',
  allowed_domains                 text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_claims                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                      uuid,
  updated_by                      uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_identity_providers_realm_chk
    CHECK (realm IN ('admin', 'staff')),
  CONSTRAINT tenant_identity_providers_protocol_chk
    CHECK (protocol IN ('oidc', 'saml')),
  CONSTRAINT tenant_identity_providers_status_chk
    CHECK (status IN ('draft', 'active', 'disabled')),
  CONSTRAINT tenant_identity_providers_provider_key_chk
    CHECK (provider_key ~ '^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$'),
  CONSTRAINT tenant_identity_providers_platform_tenant_chk
    CHECK (
      (tenant_id IS NOT NULL AND is_platform_provider = false)
      OR (tenant_id IS NULL AND is_platform_provider = true AND realm = 'admin')
    ),
  CONSTRAINT tenant_identity_providers_oidc_required_chk
    CHECK (
      status <> 'active'
      OR protocol <> 'oidc'
      OR (
        oidc_issuer IS NOT NULL
        AND oidc_authorization_endpoint IS NOT NULL
        AND oidc_token_endpoint IS NOT NULL
        AND oidc_jwks_uri IS NOT NULL
        AND oidc_client_id IS NOT NULL
      )
    )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenant_identity_providers_tenant') THEN
    ALTER TABLE tenant_identity_providers
      ADD CONSTRAINT fk_tenant_identity_providers_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_identity_providers_tenant_key
  ON tenant_identity_providers (tenant_id, realm, protocol, provider_key)
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_identity_providers_platform_key
  ON tenant_identity_providers (realm, protocol, provider_key)
  WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_identity_providers_tenant_status
  ON tenant_identity_providers (tenant_id, realm, protocol, status);
CREATE INDEX IF NOT EXISTS idx_tenant_identity_providers_platform_status
  ON tenant_identity_providers (realm, protocol, status)
  WHERE tenant_id IS NULL;

ALTER TABLE tenant_identity_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_identity_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_identity_providers;
CREATE POLICY tenant_isolation ON tenant_identity_providers
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

CREATE TABLE IF NOT EXISTS tenant_idp_role_mappings (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NULL,
  provider_id    bigint NOT NULL,
  realm          varchar(20) NOT NULL,
  idp_group      text NOT NULL,
  vh_role        varchar(80) NOT NULL,
  status         varchar(20) NOT NULL DEFAULT 'active',
  priority       integer NOT NULL DEFAULT 100,
  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_idp_role_mappings_realm_chk
    CHECK (realm IN ('admin', 'staff')),
  CONSTRAINT tenant_idp_role_mappings_status_chk
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tenant_idp_role_mappings_role_chk
    CHECK (
      (realm = 'admin' AND vh_role IN ('ADMIN', 'SUPER_ADMIN'))
      OR (realm = 'staff' AND vh_role NOT IN ('ADMIN', 'SUPER_ADMIN', 'PATIENT', 'WEBHOOK_CLIENT'))
    ),
  CONSTRAINT tenant_idp_role_mappings_tenant_platform_chk
    CHECK (tenant_id IS NOT NULL OR (realm = 'admin' AND vh_role = 'SUPER_ADMIN'))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenant_idp_role_mappings_tenant') THEN
    ALTER TABLE tenant_idp_role_mappings
      ADD CONSTRAINT fk_tenant_idp_role_mappings_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tenant_idp_role_mappings_provider') THEN
    ALTER TABLE tenant_idp_role_mappings
      ADD CONSTRAINT fk_tenant_idp_role_mappings_provider
      FOREIGN KEY (provider_id) REFERENCES tenant_identity_providers(id) ON UPDATE NO ACTION ON DELETE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_idp_role_mappings_tenant_group
  ON tenant_idp_role_mappings (tenant_id, provider_id, realm, lower(idp_group))
  WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_idp_role_mappings_platform_group
  ON tenant_idp_role_mappings (provider_id, realm, lower(idp_group))
  WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_idp_role_mappings_provider_status
  ON tenant_idp_role_mappings (provider_id, status, priority);

ALTER TABLE tenant_idp_role_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_idp_role_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_idp_role_mappings;
CREATE POLICY tenant_isolation ON tenant_idp_role_mappings
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

CREATE TABLE IF NOT EXISTS federated_identities (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NULL,
  realm          varchar(20) NOT NULL,
  provider_id    bigint NOT NULL,
  issuer         text NOT NULL,
  subject        text NOT NULL,
  local_uid      uuid NOT NULL,
  email_at_link  text,
  last_seen_at   timestamptz,
  status         varchar(20) NOT NULL DEFAULT 'active',
  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT federated_identities_realm_chk
    CHECK (realm IN ('admin', 'staff')),
  CONSTRAINT federated_identities_status_chk
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT federated_identities_tenant_platform_chk
    CHECK (tenant_id IS NOT NULL OR realm = 'admin')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_federated_identities_tenant') THEN
    ALTER TABLE federated_identities
      ADD CONSTRAINT fk_federated_identities_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_federated_identities_provider') THEN
    ALTER TABLE federated_identities
      ADD CONSTRAINT fk_federated_identities_provider
      FOREIGN KEY (provider_id) REFERENCES tenant_identity_providers(id) ON UPDATE NO ACTION ON DELETE CASCADE;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_federated_identities_subject
  ON federated_identities (provider_id, issuer, subject);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_federated_identities_local
  ON federated_identities (provider_id, local_uid);
CREATE INDEX IF NOT EXISTS idx_federated_identities_tenant_local
  ON federated_identities (tenant_id, local_uid, status);

ALTER TABLE federated_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE federated_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON federated_identities;
CREATE POLICY tenant_isolation ON federated_identities
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

CREATE TABLE IF NOT EXISTS identity_audit_events (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NULL,
  realm               varchar(20) NOT NULL,
  protocol            varchar(20) NOT NULL,
  provider_id         bigint,
  provider_key        varchar(80),
  event_type          varchar(80) NOT NULL,
  outcome             varchar(20) NOT NULL,
  actor_uid           uuid,
  local_uid           uuid,
  issuer              text,
  subject_hash        text,
  assertion_hash      text,
  state_hash          text,
  request_id          text,
  ip_address          inet,
  user_agent          text,
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_audit_events_realm_chk
    CHECK (realm IN ('admin', 'staff')),
  CONSTRAINT identity_audit_events_protocol_chk
    CHECK (protocol IN ('oidc', 'saml')),
  CONSTRAINT identity_audit_events_outcome_chk
    CHECK (outcome IN ('started', 'accepted', 'denied', 'failed', 'linked')),
  CONSTRAINT identity_audit_events_tenant_platform_chk
    CHECK (tenant_id IS NOT NULL OR realm = 'admin')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_identity_audit_events_tenant') THEN
    ALTER TABLE identity_audit_events
      ADD CONSTRAINT fk_identity_audit_events_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_identity_audit_events_provider') THEN
    ALTER TABLE identity_audit_events
      ADD CONSTRAINT fk_identity_audit_events_provider
      FOREIGN KEY (provider_id) REFERENCES tenant_identity_providers(id) ON UPDATE NO ACTION ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_identity_audit_events_tenant_time
  ON identity_audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_events_provider_time
  ON identity_audit_events (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_audit_events_type_time
  ON identity_audit_events (event_type, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_identity_audit_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'identity_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_identity_audit_events_no_update ON identity_audit_events;
CREATE TRIGGER trg_identity_audit_events_no_update
  BEFORE UPDATE ON identity_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_audit_events_mutation();

DROP TRIGGER IF EXISTS trg_identity_audit_events_no_delete ON identity_audit_events;
CREATE TRIGGER trg_identity_audit_events_no_delete
  BEFORE DELETE ON identity_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_audit_events_mutation();

ALTER TABLE identity_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity_audit_events;
CREATE POLICY tenant_isolation ON identity_audit_events
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
