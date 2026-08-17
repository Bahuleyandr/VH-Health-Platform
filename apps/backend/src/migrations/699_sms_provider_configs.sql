-- 699_sms_provider_configs.sql
--
-- SMS gateway adapter, part 1 of 2 — per-tenant provider + DLT config.
--
-- Gap: smsService.sendSMS is a dry-run logger; the outbox drain rejects
-- type='sms' rows with 'sms_gateway_not_configured'
-- (notificationOutboxDelivery.js / notificationDispatcher.js). Landing a real
-- adapter (MSG91 / Twilio shaped) for India requires TRAI DLT compliance:
-- every message must be sent with a registered sender id (header), the
-- principal entity id, and a registered content template id. Those are
-- per-tenant facts, not env vars — each hospital registers its own DLT
-- entity and templates.
--
--   * sms_provider_configs — one row per (tenant, provider); at most one
--     enabled per tenant (partial unique). Secrets (MSG91 authkey / Twilio
--     auth token) are encryptField() ciphertext (tenant_interop_secrets 338
--     idiom). callback_token_hash is the SHA-256 of a per-config bearer
--     token embedded in the delivery-status (DLR) callback URL — MSG91 does
--     not sign callbacks, so the URL token is the authentication for that
--     pre-RLS mount (Twilio additionally signs; both are verified). An
--     encrypted token copy lets the send path give Twilio its per-message
--     statusCallback without storing or logging plaintext.
--   * sms_template_registrations — maps the outbox templateVersion base key
--     (e.g. 'sms.billing_payment_link.v1', already recorded on every outbox
--     row) to the tenant's DLT content template id + the provider-side
--     template/flow id. The adapter refuses to send a template kind with no
--     active registration row — an unregistered template is a terminal
--     rejection, not a silent unbranded send.
--
-- Env-level deployment kill switch + provider credentials fallback live in
-- validateEnv.js (conditional Joi, ABDM_ENABLED idiom); per-tenant enablement
-- is tenants.settings.sms (tenantSettingsService accessor, default OFF)
-- AND config.enabled. RLS: 683 request-path pattern.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_provider_configs (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider              VARCHAR(30) NOT NULL
    CONSTRAINT chk_sms_provider_config_provider
      CHECK (provider IN ('msg91', 'twilio', 'dry_run')),
  enabled               BOOLEAN NOT NULL DEFAULT false,
  -- TRAI DLT registered header (sender id, e.g. 'VHHLTH').
  sender_id             VARCHAR(20),
  -- TRAI DLT principal entity id of the tenant hospital.
  dlt_entity_id         VARCHAR(40),
  -- MSG91 authkey / Twilio auth token — encryptField() ciphertext, write-only.
  auth_key_ciphertext   TEXT,
  -- Twilio account SID (publishable identifier; NULL for msg91/dry_run).
  account_sid           VARCHAR(64),
  -- SHA-256 hex of the bearer token embedded in this config's DLR callback
  -- URL. The DLR mount is public/pre-RLS; this token is its auth.
  callback_token_hash   CHAR(64)
    CONSTRAINT chk_sms_provider_config_cb_hash
      CHECK (callback_token_hash IS NULL OR callback_token_hash ~ '^[0-9a-f]{64}$'),
  -- encryptField() ciphertext; decrypted only inside the provider send seam.
  callback_token_ciphertext TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sms_provider_config_tenant_provider
    UNIQUE (tenant_id, provider),
  -- A live real provider must carry DLT identity + credentials.
  CONSTRAINT chk_sms_provider_config_live_shape
    CHECK (
      provider = 'dry_run'
      OR NOT enabled
      OR (
        sender_id IS NOT NULL
        AND dlt_entity_id IS NOT NULL
        AND auth_key_ciphertext IS NOT NULL
        AND callback_token_hash IS NOT NULL
        AND callback_token_ciphertext IS NOT NULL
      )
    )
);

-- Exactly one enabled SMS provider per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sms_provider_config_tenant_live
  ON sms_provider_configs (tenant_id)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS sms_template_registrations (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_config_id    INTEGER NOT NULL
    REFERENCES sms_provider_configs(id) ON DELETE CASCADE,
  -- Outbox template key base, e.g. 'sms.billing_payment_link.v1' — matches
  -- notification_outbox.template_version values queued by smsOutbox callers.
  template_key          VARCHAR(120) NOT NULL,
  -- TRAI DLT content template id (19-digit numeric string).
  dlt_template_id       VARCHAR(40) NOT NULL,
  -- Provider-side handle: MSG91 flow id / Twilio content SID. NULL when the
  -- provider takes the DLT id directly.
  provider_template_id  VARCHAR(64),
  active                BOOLEAN NOT NULL DEFAULT true,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sms_template_registration
    UNIQUE (tenant_id, provider_config_id, template_key)
);

CREATE INDEX IF NOT EXISTS idx_sms_template_registration_lookup
  ON sms_template_registrations (tenant_id, template_key)
  WHERE active;

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sms_provider_configs',
    'sms_template_registrations'
  ]
  LOOP
    EXECUTE FORMAT('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE FORMAT('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE FORMAT($policy$
      CREATE POLICY tenant_isolation ON %I
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
        )
    $policy$, table_name);
  END LOOP;
END
$rls$;

COMMENT ON TABLE sms_provider_configs IS
  'Per-tenant SMS provider config (msg91 | twilio | dry_run) with TRAI DLT identity (sender id + principal entity id). Secrets are encryptField() ciphertext. At most one enabled config per tenant. Per-tenant enablement additionally gated by tenants.settings.sms (default OFF).';
COMMENT ON COLUMN sms_provider_configs.callback_token_hash IS
  'SHA-256 of the bearer token embedded in the DLR callback URL — the auth for the pre-RLS delivery-status mount (MSG91 sends unsigned callbacks).';
COMMENT ON COLUMN sms_provider_configs.callback_token_ciphertext IS
  'Encrypted callback bearer token, decrypted only to construct the Twilio per-message statusCallback URL; never returned by config reads.';
COMMENT ON TABLE sms_template_registrations IS
  'Maps outbox template_version keys (e.g. sms.billing_payment_link.v1) to the tenant''s DLT content template id + provider flow id. No active row for a template kind = terminal send rejection, never an unregistered send.';

COMMIT;
