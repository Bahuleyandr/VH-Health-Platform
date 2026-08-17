-- 697_payment_gateway_refunds.sql
--
-- Online payment gateway, part 4 of 4 — provider refund execution rows.
--
-- Refund AUTHORITY stays in the existing billingV2 lifecycle:
-- raiseRefund → approveRefund (admin) → markRefundPaid. This table adds only
-- the provider EXECUTION leg for gateway-collected payments: once a
-- billing_refunds row is approved, the gateway adapter issues the provider
-- refund against the original provider_payment_id and records it here; the
-- refund.processed webhook then drives markRefundPaid (mode matching the
-- original electronic mode, reference = provider_refund_id) so the ledger
-- posts REFUND_PAID exactly as a manual refund would.
--
-- (Slot note: ledger slot 696 "ledger-reconciliation linkage" was folded into
-- 694's billing_payment_id/reconciled_at columns — a separate linkage table
-- would have duplicated the order row 1:1. 696 and 698 are released unused;
-- refunds keep their claimed slot 697.)
--
-- Status machine (simple CHECK list, Razorpay refund vocabulary):
--   initiated → pending → processed | failed | requires_reconciliation
-- processed requires provider_refund_id + processed_at (evidence CHECK).
-- The initiated row and provider_idempotency_key commit BEFORE the external
-- request; every retry reuses that key, closing the crash/replay window.
--
-- RLS: 683 request-path pattern; the refund webhook path is the same pre-RLS
-- mount as 695 — tenant_id always written explicitly by code.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_gateway_refunds (
  id                   SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider             VARCHAR(30) NOT NULL
    CONSTRAINT chk_pg_refund_provider
      CHECK (provider IN ('razorpay', 'dry_run')),
  environment          VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_pg_refund_environment
      CHECK (environment IN ('sandbox', 'production')),
  gateway_order_id     INTEGER NOT NULL
    REFERENCES payment_gateway_orders(id) ON DELETE CASCADE,
  -- The approved billing-side refund this execution leg serves.
  billing_refund_id    INTEGER
    REFERENCES billing_refunds(id) ON DELETE SET NULL,
  provider_payment_id  VARCHAR(120) NOT NULL,
  provider_refund_id   VARCHAR(120),
  provider_idempotency_key VARCHAR(120) NOT NULL
    CONSTRAINT chk_pg_refund_idempotency_key
      CHECK (provider_idempotency_key ~ '^[A-Za-z0-9_-]{10,120}$'),
  amount               DECIMAL(12, 2) NOT NULL
    CONSTRAINT chk_pg_refund_amount_positive CHECK (amount > 0),
  currency             VARCHAR(3) NOT NULL DEFAULT 'INR',
  status               VARCHAR(30) NOT NULL DEFAULT 'initiated'
    CONSTRAINT chk_pg_refund_status
      CHECK (status IN ('initiated', 'pending', 'processed', 'failed', 'requires_reconciliation')),
  reason               VARCHAR(500),
  initiated_by         UUID,
  initiated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  failure_code         VARCHAR(80),
  failure_reason       VARCHAR(500),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pg_refund_processed_evidence
    CHECK (
      status <> 'processed'
      OR (provider_refund_id IS NOT NULL AND processed_at IS NOT NULL)
    )
);

-- Refund webhook replay dedupe backstop.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_tenant_provider_refund
  ON payment_gateway_refunds (tenant_id, provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_provider_idempotency
  ON payment_gateway_refunds (tenant_id, provider, provider_idempotency_key);

-- One in-flight execution leg per approved billing refund.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_billing_refund_live
  ON payment_gateway_refunds (tenant_id, billing_refund_id)
  WHERE billing_refund_id IS NOT NULL
    AND status IN ('initiated', 'pending', 'processed', 'requires_reconciliation');

CREATE INDEX IF NOT EXISTS idx_pg_refund_tenant_status
  ON payment_gateway_refunds (tenant_id, status, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_refund_order
  ON payment_gateway_refunds (gateway_order_id);

ALTER TABLE payment_gateway_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_gateway_refunds;
CREATE POLICY tenant_isolation ON payment_gateway_refunds
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

COMMENT ON TABLE payment_gateway_refunds IS
  'Provider refund execution rows for gateway-collected payments. Authority stays in billing_refunds (raiseRefund/approveRefund/markRefundPaid); this is the execution+evidence leg. processed requires provider_refund_id + processed_at.';
COMMENT ON COLUMN payment_gateway_refunds.billing_refund_id IS
  'Approved billing_refunds row this provider refund executes. markRefundPaid is driven by the refund.processed webhook with reference = provider_refund_id.';
COMMENT ON COLUMN payment_gateway_refunds.provider_idempotency_key IS
  'Durable provider retry key persisted before the irreversible refund API call; retries reuse the same key and request body.';

COMMIT;
