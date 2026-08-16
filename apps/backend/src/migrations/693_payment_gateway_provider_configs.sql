-- 693_payment_gateway_provider_configs.sql
--
-- Online payment gateway, part 1 of 4 — per-tenant provider configuration.
--
-- Gap: the only "online payment" today is billing_payment_links (152) building
-- raw upi:// deep links from env vars (HOSPITAL_UPI_VPA), reconciled manually
-- by a cashier via markPaymentLinkPaid. There is no provider abstraction, no
-- card acceptance, no webhook-driven capture. This wave adds a
-- provider-abstracted gateway layer (Razorpay-shaped adapter + a dry_run
-- sandbox provider) on top of the EXISTING money tables: gateway rows
-- reference billing_invoices / billing_payments / billing_payment_links and
-- never fork a parallel money ledger.
--
-- This table holds per-tenant provider selection + credentials:
--   * Secrets (API key secret, webhook secret) are stored as
--     encryptField() ciphertext, following tenant_interop_secrets (338).
--     They are never returned by list/read APIs — write-only columns.
--   * Feature gating is per-tenant via tenants.settings.paymentGateway
--     (tenantSettingsService accessor, disabled by default, ambulance-683
--     idiom) — a config row existing does NOT enable the feature; both the
--     settings gate AND config.enabled must be true.
--   * environment 'sandbox' is the default; 'dry_run' provider needs no
--     credentials and echoes deterministic fake provider ids so the whole
--     flow is exercisable without a Razorpay account.
--   * At most ONE enabled config per tenant (partial unique below) — the
--     adapter resolves "the tenant's gateway" unambiguously.
--
-- RLS follows the ambulance_position_events (683) request-path pattern:
-- permissive tenant_isolation; services always write tenant_id explicitly.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_gateway_provider_configs (
  id                        SERIAL PRIMARY KEY,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                  VARCHAR(30) NOT NULL
    CONSTRAINT chk_pg_provider_config_provider
      CHECK (provider IN ('razorpay', 'dry_run')),
  environment               VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_pg_provider_config_environment
      CHECK (environment IN ('sandbox', 'production')),
  enabled                   BOOLEAN NOT NULL DEFAULT false,
  display_name              VARCHAR(120),
  -- Razorpay key_id is a publishable identifier; the paired secret and the
  -- webhook signing secret are encryptField() ciphertext (338 idiom).
  key_id                    VARCHAR(120),
  key_secret_ciphertext     TEXT,
  webhook_secret_ciphertext TEXT,
  -- Payment methods offered to patients through this config.
  accepted_methods          TEXT[] NOT NULL DEFAULT ARRAY['upi', 'card']::text[],
  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by                UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pg_provider_config_tenant_provider_env
    UNIQUE (tenant_id, provider, environment),
  -- A live (non-dry-run) config must carry real credentials.
  CONSTRAINT chk_pg_provider_config_live_credentials
    CHECK (
      provider = 'dry_run'
      OR NOT enabled
      OR (key_id IS NOT NULL AND key_secret_ciphertext IS NOT NULL
          AND webhook_secret_ciphertext IS NOT NULL)
    )
);

-- Exactly one enabled gateway config per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_provider_config_tenant_live
  ON payment_gateway_provider_configs (tenant_id)
  WHERE enabled;

CREATE INDEX IF NOT EXISTS idx_pg_provider_config_tenant
  ON payment_gateway_provider_configs (tenant_id, provider, environment);

ALTER TABLE payment_gateway_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_provider_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_gateway_provider_configs;
CREATE POLICY tenant_isolation ON payment_gateway_provider_configs
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

COMMENT ON TABLE payment_gateway_provider_configs IS
  'Per-tenant online payment gateway provider config (razorpay | dry_run). Secrets are encryptField() ciphertext, write-only (338 idiom). At most one enabled config per tenant. Feature additionally gated by tenants.settings.paymentGateway (default OFF).';
COMMENT ON COLUMN payment_gateway_provider_configs.key_secret_ciphertext IS
  'encryptField() ciphertext of the provider API key secret. Never returned by read APIs.';
COMMENT ON COLUMN payment_gateway_provider_configs.webhook_secret_ciphertext IS
  'encryptField() ciphertext of the provider webhook signing secret (HMAC-SHA256 over raw body).';

COMMIT;
