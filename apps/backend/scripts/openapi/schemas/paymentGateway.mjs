// apps/backend/scripts/openapi/schemas/paymentGateway.mjs
// Online payment gateway (migrations 693-697): provider-abstracted UPI/card
// checkout served from /api/v1/billing/gateway/* plus the public
// provider-signed webhook at /webhooks/payments/{webhookToken}.
// Config-gated DEFAULT OFF: writes 403 PAYMENT_GATEWAY_DISABLED until the
// PAYMENT_GATEWAY_ENABLED env switch, tenants.settings.paymentGateway.enabled,
// and an enabled provider config row all hold.
import { envelope } from './_helpers.mjs';

export const schemas = {
  PaymentGatewayOrderCreateRequest: {
    type: 'object',
    properties: {
      invoice_id: {
        type: 'integer',
        nullable: true,
        description: 'billing_invoices id to pay (ISSUED/PARTIAL). One of invoice_id or payment_link_token is required.',
      },
      payment_link_token: {
        type: 'string',
        nullable: true,
        maxLength: 64,
        description: 'billing_payment_links token when the order is created from the payment-link flow.',
      },
      amount: {
        type: 'number',
        minimum: 0.01,
        nullable: true,
        description: 'Rupees. Defaults to the invoice amount due (or the link amount); may not exceed it.',
      },
    },
  },

  PaymentGatewayOrderCheckout: {
    type: 'object',
    required: ['orderId', 'providerOrderId', 'provider', 'amount', 'currency', 'status'],
    properties: {
      orderId: { type: 'integer' },
      providerOrderId: { type: 'string', description: 'Provider-side order id (Razorpay order id / deterministic dry_run id).' },
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      keyId: {
        type: 'string',
        nullable: true,
        description: 'Publishable provider key id for checkout bootstrap. Never the key secret.',
      },
      amount: { type: 'number', description: 'Rupees (DECIMAL); the provider wire amount is paise.' },
      currency: { type: 'string' },
      acceptedMethods: { type: 'array', items: { type: 'string', enum: ['upi', 'card', 'netbanking', 'wallet'] } },
      status: { type: 'string', enum: ['created', 'attempted', 'paid', 'failed', 'cancelled', 'expired', 'requires_reconciliation'] },
      invoiceId: { type: 'integer', nullable: true },
      paymentLinkId: { type: 'integer', nullable: true },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  PaymentGatewayOrder: {
    type: 'object',
    required: ['id', 'provider', 'amount', 'currency', 'status'],
    properties: {
      id: { type: 'integer' },
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      patient_uid: { type: 'string', format: 'uuid' },
      invoice_id: { type: 'integer', nullable: true },
      payment_link_id: { type: 'integer', nullable: true },
      amount: { type: 'number' },
      currency: { type: 'string' },
      receipt: { type: 'string', nullable: true },
      provider_order_id: { type: 'string', nullable: true },
      provider_payment_id: { type: 'string', nullable: true },
      method: { type: 'string', nullable: true, enum: ['upi', 'card', 'netbanking', 'wallet', 'other', null] },
      status: { type: 'string', enum: ['created', 'attempted', 'paid', 'failed', 'cancelled', 'expired', 'requires_reconciliation'] },
      billing_payment_id: {
        type: 'integer',
        nullable: true,
        description: 'The billing_payments row collectPayment booked in the same transaction that marked this order paid.',
      },
      captured_at: { type: 'string', format: 'date-time', nullable: true },
      reconciled_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'When an operator stamped the manual resolution of a requires_reconciliation order.',
      },
      reconciliation_note: { type: 'string', nullable: true, maxLength: 500 },
      failure_code: { type: 'string', nullable: true },
      failure_reason: { type: 'string', nullable: true },
      expires_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  PaymentGatewayReconciliationList: {
    type: 'object',
    required: ['orders', 'limit', 'offset'],
    properties: {
      orders: { type: 'array', items: { $ref: '#/components/schemas/PaymentGatewayOrder' } },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
  },

  PaymentGatewayOrderReconcileRequest: {
    type: 'object',
    required: ['note'],
    properties: {
      note: {
        type: 'string',
        minLength: 10,
        maxLength: 500,
        description: 'What was manually done about the captured money (booked via collectPayment, refunded at the provider dashboard, ...).',
      },
    },
  },

  PaymentGatewayRefundCreateRequest: {
    type: 'object',
    required: ['billing_refund_id'],
    properties: {
      billing_refund_id: {
        type: 'integer',
        description: 'APPROVED billing_refunds row to execute at the provider. Authority stays in billing_refunds; this creates the provider execution leg only.',
      },
    },
  },

  PaymentGatewayRefund: {
    type: 'object',
    required: ['id', 'provider', 'amount', 'status'],
    properties: {
      id: { type: 'integer' },
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      gateway_order_id: { type: 'integer' },
      billing_refund_id: { type: 'integer', nullable: true },
      provider_payment_id: { type: 'string' },
      provider_refund_id: { type: 'string', nullable: true },
      amount: { type: 'number' },
      currency: { type: 'string' },
      status: { type: 'string', enum: ['initiated', 'pending', 'processed', 'failed'] },
      reason: { type: 'string', nullable: true },
      initiated_at: { type: 'string', format: 'date-time' },
      processed_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  PaymentGatewayConfigUpsertRequest: {
    type: 'object',
    required: ['provider', 'enabled'],
    properties: {
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
      enabled: { type: 'boolean', description: 'REQUIRED (explicit true/false): the upsert takes this value verbatim, so omission would silently disable a live config. At most one enabled config per tenant; enabling a non-dry_run provider requires key_id + key_secret.' },
      display_name: { type: 'string', nullable: true, maxLength: 120 },
      key_id: { type: 'string', nullable: true, maxLength: 120, description: 'Publishable provider key id.' },
      key_secret: { type: 'string', nullable: true, description: 'WRITE-ONLY. Stored as encryptField() ciphertext; never returned by any read.' },
      webhook_secret: { type: 'string', nullable: true, description: 'WRITE-ONLY webhook signing secret (HMAC-SHA256 over raw body); stored encrypted.' },
      accepted_methods: { type: 'array', items: { type: 'string', enum: ['upi', 'card', 'netbanking', 'wallet'] } },
    },
  },

  PaymentGatewayConfigView: {
    type: 'object',
    required: ['id', 'provider', 'environment', 'enabled'],
    properties: {
      id: { type: 'integer' },
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      enabled: { type: 'boolean' },
      display_name: { type: 'string', nullable: true },
      key_id: { type: 'string', nullable: true },
      accepted_methods: { type: 'array', items: { type: 'string' } },
      has_key_secret: { type: 'boolean', description: 'Secrets are write-only; reads expose presence booleans only.' },
      has_webhook_secret: { type: 'boolean' },
      webhook_path: {
        type: 'string',
        nullable: true,
        description: 'Tenant-specific webhook path (/webhooks/payments/<token>) to configure at the provider dashboard.',
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  PaymentGatewayConfigList: {
    type: 'object',
    required: ['env_enabled', 'tenant_enabled', 'configs'],
    properties: {
      env_enabled: { type: 'boolean', description: 'PAYMENT_GATEWAY_ENABLED deployment kill switch.' },
      tenant_enabled: { type: 'boolean', description: 'tenants.settings.paymentGateway.enabled.' },
      configs: { type: 'array', items: { $ref: '#/components/schemas/PaymentGatewayConfigView' } },
    },
  },

  PaymentGatewayWebhookAck: {
    type: 'object',
    required: ['received'],
    properties: {
      received: { type: 'boolean' },
      replay: { type: 'boolean', description: 'true when the provider event id was already recorded and fully handled.' },
      outcome: { type: 'string', description: 'Handler outcome for this delivery (captured, replay, ignored, refund_processed, requires_reconciliation, failed, ...).' },
    },
  },

  PaymentGatewayReconciliationListResponse: envelope('PaymentGatewayReconciliationList'),
  PaymentGatewayOrderCheckoutResponse: envelope('PaymentGatewayOrderCheckout'),
  PaymentGatewayOrderResponse: envelope('PaymentGatewayOrder'),
  PaymentGatewayRefundResponse: envelope('PaymentGatewayRefund'),
  PaymentGatewayConfigListResponse: envelope('PaymentGatewayConfigList'),
  PaymentGatewayConfigViewResponse: envelope('PaymentGatewayConfigView'),
  PaymentGatewayWebhookAckResponse: envelope('PaymentGatewayWebhookAck'),
};

export const operations = {
  'POST /api/v1/billing/gateway/orders': {
    description:
      'Creates a provider payment order (Razorpay order or deterministic dry_run order) tied to an invoice or an existing payment link, returning the checkout bootstrap (provider order id + publishable key id — never a secret). Requires Idempotency-Key (scope payment_gateway_order, retained on 5xx). 403 PAYMENT_GATEWAY_DISABLED until the tenant gateway is effectively enabled; a PATIENT caller may only pay their own bills.',
    request: 'PaymentGatewayOrderCreateRequest',
    response: 'PaymentGatewayOrderCheckoutResponse',
  },
  'GET /api/v1/billing/gateway/orders/{id}': {
    description:
      'Gateway order status poll (created → attempted → paid | failed | cancelled | expired | requires_reconciliation). A PATIENT caller sees only their own orders; a paid order carries the billing_payments id booked by collectPayment in the same transaction.',
    response: 'PaymentGatewayOrderResponse',
  },
  'POST /api/v1/billing/gateway/orders/{id}/cancel': {
    description:
      'Cancels a gateway order still in created/attempted. A capture webhook that arrives later still books the provider money (the provider capture is authoritative); cancel only stops the local checkout window.',
    response: 'PaymentGatewayOrderResponse',
  },
  'GET /api/v1/billing/gateway/reconciliation': {
    description:
      'Admin work queue of requires_reconciliation orders — captures the provider took that automation could not book (voided invoice, amount drift). Unresolved rows only by default; include_resolved=true also returns operator-stamped rows.',
    response: 'PaymentGatewayReconciliationListResponse',
  },
  'POST /api/v1/billing/gateway/orders/{id}/reconcile': {
    description:
      'Admin resolution stamp for a requires_reconciliation order: records reconciled_at + a required note describing how the captured money was manually handled, and writes an audit row. The order status stays requires_reconciliation (694 has no reconciled status) — stamped rows drop out of the default work-queue listing.',
    request: 'PaymentGatewayOrderReconcileRequest',
    response: 'PaymentGatewayOrderResponse',
  },
  'POST /api/v1/billing/gateway/refunds': {
    description:
      'Executes an APPROVED billing_refunds row at the provider (refund of the original gateway capture). Execution/evidence leg only: refund authority stays in the billingV2 raiseRefund → approveRefund → markRefundPaid lifecycle, and markRefundPaid is driven by the refund.processed webhook with reference = provider refund id. Finance/cashier/admin roles; Idempotency-Key required (scope payment_gateway_refund).',
    request: 'PaymentGatewayRefundCreateRequest',
    response: 'PaymentGatewayRefundResponse',
  },
  'GET /api/v1/billing/gateway/config': {
    description:
      'Admin read of the tenant provider configs plus the env/tenant gate states. Secrets are write-only — reads expose has_key_secret / has_webhook_secret booleans and the tenant webhook path only.',
    response: 'PaymentGatewayConfigListResponse',
  },
  'PUT /api/v1/billing/gateway/config': {
    description:
      'Admin upsert of the per-tenant provider config (one row per provider+environment; at most one enabled per tenant). key_secret / webhook_secret are write-only and stored as encryptField() ciphertext; enabling a non-dry_run provider without credentials is rejected. The webhook routing token is minted once and stays stable.',
    request: 'PaymentGatewayConfigUpsertRequest',
    response: 'PaymentGatewayConfigViewResponse',
  },
  'POST /webhooks/payments/{webhookToken}': {
    description:
      'Public provider webhook intake (pre-auth mount). The opaque URL token resolves the tenant fail-closed (unknown → 404, nothing written); authenticity is HMAC-SHA256 over the raw body vs x-razorpay-signature, verified timing-safe against the tenant’s encrypted webhook secret. Deliveries are recorded durably before processing; the UNIQUE (tenant, provider, provider_event_id) key plus a cross-replica replay claim collapse redeliveries, which are 200-acked without reprocessing. payment.captured/order.paid books money exclusively through collectPayment with billing_payments.reference = provider payment id; unbookable captures park as requires_reconciliation and are still 2xx-acked.',
    response: 'PaymentGatewayWebhookAckResponse',
  },
};
