-- 694_payment_gateway_orders.sql
--
-- Online payment gateway, part 2 of 4 — provider order/intent rows.
--
-- One row per gateway order created at a provider (Razorpay "order", or a
-- deterministic dry_run equivalent). The order is the durable handle tying
-- the provider-side money movement to the EXISTING billing spine:
--   * invoice_id      → billing_invoices (what is being paid)
--   * payment_link_id → billing_payment_links (when the order was created
--                       from the 152 payment-link flow; the link page swaps
--                       its raw upi:// deep link for a gateway checkout when
--                       the tenant's gateway is enabled)
--   * billing_payment_id → billing_payments (the money row collectPayment
--                       created when the capture was booked; the gateway
--                       NEVER forks a parallel money table)
--
-- Money booking invariant: a webhook/poll capture books money exclusively
-- through billingV2Service.collectPayment inside ONE setTenantTx (the
-- markPaymentLinkPaid shape), with billing_payments.reference =
-- provider_payment_id so migration 317's (tenant_id, reference, mode)
-- partial unique is the durable replay backstop — a replayed capture event
-- collapses onto the existing payment row.
--
-- Status machine (simple CHECK list; Razorpay order vocabulary + local
-- terminal states):
--   created → attempted → paid | failed | cancelled | expired
--                       → requires_reconciliation  (captured at the provider
--                         but could not be booked locally, e.g. invoice
--                         voided between order and capture — surfaced to
--                         billing admins, resolved manually)
-- Evidence CHECKs pin the honest states: paid requires the provider payment
-- id AND the booked billing_payments row; requires_reconciliation requires
-- the provider payment id.
--
-- RLS follows the 683 request-path pattern. The webhook intake path is a
-- pre-RLS public mount: handler code resolves the tenant from the order row
-- (looked up by provider identifiers with an explicit tenant predicate) and
-- always writes tenant_id explicitly.

BEGIN;

CREATE TABLE IF NOT EXISTS payment_gateway_orders (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider              VARCHAR(30) NOT NULL
    CONSTRAINT chk_pg_order_provider
      CHECK (provider IN ('razorpay', 'dry_run')),
  environment           VARCHAR(20) NOT NULL DEFAULT 'sandbox'
    CONSTRAINT chk_pg_order_environment
      CHECK (environment IN ('sandbox', 'production')),
  provider_config_id    INTEGER
    REFERENCES payment_gateway_provider_configs(id) ON DELETE SET NULL,
  patient_uid           UUID NOT NULL,
  invoice_id            INTEGER
    REFERENCES billing_invoices(id) ON DELETE SET NULL,
  payment_link_id       INTEGER
    REFERENCES billing_payment_links(id) ON DELETE SET NULL,
  amount                DECIMAL(12, 2) NOT NULL
    CONSTRAINT chk_pg_order_amount_positive CHECK (amount > 0),
  currency              VARCHAR(3) NOT NULL DEFAULT 'INR',
  -- Local receipt string sent to the provider at order create (idempotent
  -- create key on the provider side; also our correlation handle).
  receipt               VARCHAR(64),
  provider_order_id     VARCHAR(120),
  provider_payment_id   VARCHAR(120),
  -- Method actually used, as reported by the provider on capture.
  method                VARCHAR(20)
    CONSTRAINT chk_pg_order_method
      CHECK (method IS NULL OR method IN ('upi', 'card', 'netbanking', 'wallet', 'other')),
  status                VARCHAR(26) NOT NULL DEFAULT 'created'
    CONSTRAINT chk_pg_order_status
      CHECK (status IN (
        'created', 'attempted', 'paid', 'failed', 'cancelled', 'expired',
        'requires_reconciliation'
      )),
  -- Reconciliation linkage: the booked money row + when/how it was booked.
  billing_payment_id    INTEGER
    REFERENCES billing_payments(id) ON DELETE SET NULL,
  captured_at           TIMESTAMPTZ,
  reconciled_at         TIMESTAMPTZ,
  reconciliation_note   VARCHAR(500),
  failure_code          VARCHAR(80),
  failure_reason        VARCHAR(500),
  expires_at            TIMESTAMPTZ,
  created_by            UUID,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- paid = money booked: provider payment id + billing_payments row + instant.
  CONSTRAINT chk_pg_order_paid_evidence
    CHECK (
      status <> 'paid'
      OR (
        provider_payment_id IS NOT NULL
        AND billing_payment_id IS NOT NULL
        AND captured_at IS NOT NULL
      )
    ),
  -- requires_reconciliation = the provider captured money we could not book.
  CONSTRAINT chk_pg_order_reconciliation_evidence
    CHECK (
      status <> 'requires_reconciliation'
      OR (provider_payment_id IS NOT NULL AND captured_at IS NOT NULL)
    )
);

-- Provider order id is the webhook correlation key — one row per provider
-- order per tenant/provider (replay dedupe backstop for order.* events).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_order_tenant_provider_order
  ON payment_gateway_orders (tenant_id, provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_order_tenant_receipt
  ON payment_gateway_orders (tenant_id, receipt)
  WHERE receipt IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_order_tenant_status
  ON payment_gateway_orders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_order_patient
  ON payment_gateway_orders (tenant_id, patient_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_order_invoice
  ON payment_gateway_orders (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pg_order_payment_link
  ON payment_gateway_orders (payment_link_id) WHERE payment_link_id IS NOT NULL;
-- Expiry sweep (scheduler job, expireStaleLinks idiom).
CREATE INDEX IF NOT EXISTS idx_pg_order_expiry
  ON payment_gateway_orders (expires_at)
  WHERE status IN ('created', 'attempted');

ALTER TABLE payment_gateway_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment_gateway_orders;
CREATE POLICY tenant_isolation ON payment_gateway_orders
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

COMMENT ON TABLE payment_gateway_orders IS
  'Provider payment order/intent rows (Razorpay-shaped). References billing_invoices / billing_payment_links / billing_payments — never a parallel money table. Capture books money via collectPayment with billing_payments.reference = provider_payment_id (migration 317 unique is the replay backstop).';
COMMENT ON COLUMN payment_gateway_orders.billing_payment_id IS
  'The billing_payments row collectPayment created when this capture was booked, in the same setTenantTx that flipped status to paid.';
COMMENT ON COLUMN payment_gateway_orders.status IS
  'created → attempted → paid | failed | cancelled | expired | requires_reconciliation (captured at provider, not bookable locally — manual resolution).';

COMMIT;
