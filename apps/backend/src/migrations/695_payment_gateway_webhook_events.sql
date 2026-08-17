-- 695_payment_gateway_webhook_events.sql
--
-- Online payment gateway, part 3 of 4 — durable provider webhook event log.
--
-- Every webhook POST that passes signature verification is recorded here
-- BEFORE any processing (record-intake → duplicate ⇒ 202 → process → mark
-- processed/failed — the abdmRoutes callback handler shape). The unique
-- (tenant_id, provider, provider_event_id) key is the durable cross-replica
-- replay guard: Razorpay redelivers events until 2xx, and the same event id
-- re-presented collapses onto the existing row (handler answers 200 without
-- reprocessing). This complements, not replaces, migration 317's
-- (tenant_id, reference, mode) unique on billing_payments — the money-level
-- backstop holds even if this log were truncated.
--
-- The webhook mount is public/pre-RLS (provider-signature-authenticated,
-- HMAC-SHA256 over the RAW body — app.js raw-body capture list must include
-- the webhook path). Tenant resolution happens in code (order lookup by
-- provider identifiers, or single-tenant default) and tenant_id is ALWAYS
-- written explicitly — the migration-238/336 GUC-reading DEFAULT idiom is
-- deliberately NOT used here; an unresolvable tenant is a rejected event,
-- never a default-tenant row.
--
-- payload is the parsed event JSON; raw_body_sha256 fingerprints the exact
-- signed bytes for dispute evidence without storing card-network PANs (the
-- provider payload itself is already PAN-free).

BEGIN;

CREATE TABLE IF NOT EXISTS payment_gateway_webhook_events (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            VARCHAR(30) NOT NULL
    CONSTRAINT chk_pg_webhook_provider
      CHECK (provider IN ('razorpay', 'dry_run')),
  environment         VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_pg_webhook_environment
      CHECK (environment IN ('sandbox', 'production')),
  -- Razorpay: x-razorpay-event-id header. dry_run: deterministic synthetic id.
  provider_event_id   VARCHAR(160) NOT NULL,
  event_type          VARCHAR(120) NOT NULL,
  signature_verified  BOOLEAN NOT NULL DEFAULT false,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_body_sha256     CHAR(64)
    CONSTRAINT chk_pg_webhook_raw_sha
      CHECK (raw_body_sha256 IS NULL OR raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Extracted correlation identifiers (nullable — not every event carries all).
  provider_order_id   VARCHAR(120),
  provider_payment_id VARCHAR(120),
  provider_refund_id  VARCHAR(120),
  gateway_order_id    INTEGER
    REFERENCES payment_gateway_orders(id) ON DELETE SET NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_pg_webhook_status
      CHECK (status IN ('pending', 'processed', 'ignored', 'failed')),
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ,
  failure_reason      VARCHAR(500),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pg_webhook_tenant_provider_event
    UNIQUE (tenant_id, provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_pg_webhook_tenant_status
  ON payment_gateway_webhook_events (tenant_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_webhook_order
  ON payment_gateway_webhook_events (gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pg_webhook_provider_payment
  ON payment_gateway_webhook_events (tenant_id, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

ALTER TABLE payment_gateway_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_webhook_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_gateway_webhook_events;
CREATE POLICY tenant_isolation ON payment_gateway_webhook_events
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

COMMENT ON TABLE payment_gateway_webhook_events IS
  'Durable signed-webhook intake log (record → dedupe → process → mark, abdm-callback shape). UNIQUE (tenant_id, provider, provider_event_id) is the replay guard. Written from a pre-RLS public mount: tenant_id is always resolved and written explicitly by code.';
COMMENT ON COLUMN payment_gateway_webhook_events.provider_event_id IS
  'Provider-assigned event id (Razorpay x-razorpay-event-id). Redelivered events collapse onto the existing row and are re-acked without reprocessing.';

COMMIT;
