// apps/backend/scripts/openapi/schemas/paymentGateway.mjs
// Online payment gateway (migrations 693-697): provider-abstracted UPI/card
// checkout served from /api/v1/billing/gateway/* plus the public
// provider-signed webhook at /webhooks/payments/{webhookToken}.
// Config-gated DEFAULT OFF: writes 403 PAYMENT_GATEWAY_DISABLED until the
// PAYMENT_GATEWAY_ENABLED env switch, tenants.settings.paymentGateway.enabled,
// and an enabled provider config row all hold.
import { envelope } from './_helpers.mjs';

const errorResponse = description => ({
  description,
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/PaymentGatewayErrorResponse' } },
  },
});

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
  description: 'Required durable request identity. Reuse is valid only for the exact same actor, scope, path, and body.',
};

const authenticatedSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];

export const schemas = {
  PaymentGatewayErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
    },
  },

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
        multipleOf: 0.01,
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
      reconciled_by: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Authenticated same-tenant operator who recorded the reconciliation.',
      },
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
    required: ['billing_refund_id', 'gateway_order_id'],
    properties: {
      billing_refund_id: {
        type: 'integer',
        minimum: 1,
        description: 'APPROVED billing_refunds row to execute at the provider. Authority stays in billing_refunds; this creates the provider execution leg only.',
      },
      gateway_order_id: {
        type: 'integer',
        minimum: 1,
        description: 'Exact paid gateway order whose captured payment, payer, invoice, mode, and provider config must match the approved refund.',
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
      status: { type: 'string', enum: ['initiated', 'pending', 'processed', 'failed', 'requires_reconciliation'] },
      reason: { type: 'string', nullable: true },
      initiated_at: { type: 'string', format: 'date-time' },
      processed_at: { type: 'string', format: 'date-time', nullable: true },
      failed_at: { type: 'string', format: 'date-time', nullable: true },
      failure_code: { type: 'string', nullable: true },
      failure_reason: { type: 'string', nullable: true },
      reconciled_at: { type: 'string', format: 'date-time', nullable: true },
      reconciliation_note: { type: 'string', nullable: true, maxLength: 500 },
      reconciled_by: { type: 'string', format: 'uuid', nullable: true },
      reconciliation_disposition: {
        type: 'string',
        nullable: true,
        enum: ['provider_processed', 'provider_failed', 'provider_pending', 'provider_status_unknown'],
        description: 'Latest structured manual review outcome. Processed, pending, unknown, and provider_failed without an exact validated provider refund id remain open until trusted provider evidence resolves the leg.',
      },
      reconciliation_evidence: {
        type: 'object',
        nullable: true,
        additionalProperties: false,
        required: ['source', 'reference', 'observed_at', 'provider_status'],
        properties: {
          source: {
            type: 'string',
            enum: ['provider_dashboard', 'provider_support', 'bank_statement', 'other_authoritative'],
          },
          reference: { type: 'string', minLength: 6, maxLength: 255 },
          observed_at: { type: 'string', format: 'date-time' },
          provider_status: { type: 'string', enum: ['processed', 'failed', 'pending', 'unknown'] },
          notes: { type: 'string', nullable: true, maxLength: 500 },
        },
        description: 'Operator-supplied review evidence. It never represents trusted provider-adapter success evidence.',
      },
      reconciliation_reviewed_by: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Authenticated same-tenant administrator who recorded the latest structured review.',
      },
      reconciliation_reviewed_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
      provider_request_fingerprint: {
        type: 'string',
        pattern: '^[0-9a-f]{64}$',
        description: 'Database-derived identity of the exact provider retry authority. The provider idempotency key itself is never returned.',
      },
      recovery_state: {
        type: 'string',
        enum: ['queued', 'claimed', 'provider_pending', 'retry_wait', 'blocked_authority', 'succeeded', 'failed', 'requires_reconciliation'],
      },
      recovery_attempt_count: { type: 'integer', minimum: 0 },
      recovery_next_attempt_at: { type: 'string', format: 'date-time', nullable: true },
      recovery_last_attempt_at: { type: 'string', format: 'date-time', nullable: true },
      provider_status_checked_at: { type: 'string', format: 'date-time', nullable: true },
      recovery_last_error_code: { type: 'string', nullable: true },
      recovery_last_error_reason: { type: 'string', nullable: true },
      recovery_terminal_at: { type: 'string', format: 'date-time', nullable: true },
      recovery_task_id: { type: 'integer', nullable: true },
      recovery_task_status: { type: 'string', nullable: true },
      recovery_task_owner_role: { type: 'string', nullable: true },
      recovery_sla_instance_id: { type: 'string', format: 'uuid', nullable: true },
      recovery_sla_status: { type: 'string', nullable: true },
      recovery_sla_due_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  PaymentGatewayRefundCandidate: {
    type: 'object',
    additionalProperties: false,
    required: [
      'gateway_order_id', 'provider', 'environment', 'amount',
      'refundable_amount',
    ],
    properties: {
      gateway_order_id: { type: 'integer', minimum: 1 },
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      method: { type: 'string', nullable: true },
      amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
      refundable_amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
      paid_at: { type: 'string', format: 'date-time', nullable: true },
      payment_reference: { type: 'string', nullable: true },
    },
  },
  PaymentGatewayRefundCandidateList: {
    type: 'array',
    items: { $ref: '#/components/schemas/PaymentGatewayRefundCandidate' },
  },
  PaymentGatewayRefundCandidateListResponse: envelope('PaymentGatewayRefundCandidateList'),

  PaymentGatewayRefundReconciliationList: {
    type: 'object',
    required: ['refunds', 'limit', 'offset'],
    properties: {
      refunds: { type: 'array', items: { $ref: '#/components/schemas/PaymentGatewayRefund' } },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
  },

  PaymentGatewayRefundReconcileRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition'],
    description: 'One endpoint, two rails, selected by disposition. The four structured-review dispositions carry the `evidence` object owned by the durable refund-recovery obligation. The two operator-terminal dispositions (provider_not_refunded / manual_settled) carry the local settlement tuple `note` + `evidence_reference` (+ `recovery_path`) that hands billing payout authority over. Mixing the two shapes in one body is rejected.',
    oneOf: [
      {
        title: 'PaymentGatewayRefundStructuredReview',
        required: ['disposition', 'evidence'],
      },
      {
        title: 'PaymentGatewayRefundOperatorSettlement',
        required: ['disposition', 'note', 'evidence_reference'],
      },
    ],
    properties: {
      disposition: {
        type: 'string',
        enum: [
          'provider_processed', 'provider_failed', 'provider_pending', 'provider_status_unknown',
          'provider_not_refunded', 'manual_settled',
        ],
        description: 'Structured review outcome or operator-terminal decision. provider_processed, provider_pending, and provider_status_unknown remain open and pollable. provider_failed is terminal only when an exact validated provider refund id is already bound; otherwise it remains open and replacement-blocking. Processed and failed observations require an independent reviewer. provider_not_refunded closes this execution as failed; manual_settled settles billing and the execution from attributable provider evidence.',
      },
      evidence_reference: {
        type: 'string',
        minLength: 6,
        maxLength: 120,
        description: 'Provider case/reference for provider_not_refunded, or the exact provider refund identifier for manual_settled.',
      },
      recovery_path: {
        type: 'string',
        enum: ['gateway_retry'],
        nullable: true,
        description: 'Required only for provider_not_refunded. gateway_retry retains authoritative integrated-gateway ownership; electronic refunds cannot be released to manual payout.',
      },
      note: {
        type: 'string',
        minLength: 10,
        maxLength: 500,
        description: 'What the operator verified or completed at the provider and in billing for this parked refund. Required by the operator-terminal rail only; the structured-review rail carries context in evidence.notes instead.',
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'reference', 'observed_at', 'provider_status'],
        properties: {
          source: {
            type: 'string',
            enum: ['provider_dashboard', 'provider_support', 'bank_statement', 'other_authoritative'],
          },
          reference: {
            type: 'string',
            minLength: 6,
            maxLength: 255,
            description: 'Durable provider, support, or statement reference for the review evidence.',
          },
          observed_at: {
            type: 'string',
            format: 'date-time',
            description: 'When the evidence was observed. It must not be later than server acceptance time; no future clock skew is accepted.',
          },
          provider_status: {
            type: 'string',
            enum: ['processed', 'failed', 'pending', 'unknown'],
            description: 'Must match disposition: provider_processed=processed, provider_failed=failed, provider_pending=pending, provider_status_unknown=unknown.',
          },
          notes: {
            type: 'string',
            nullable: true,
            maxLength: 500,
            description: 'Optional context; never a substitute for the structured evidence fields.',
          },
        },
      },
    },
  },

  PaymentGatewayConfigUpsertRequest: {
    type: 'object',
    required: ['provider', 'enabled'],
    properties: {
      provider: { type: 'string', enum: ['razorpay', 'dry_run'] },
      environment: { type: 'string', enum: ['sandbox', 'production'], default: 'sandbox' },
      enabled: { type: 'boolean', description: 'REQUIRED (explicit true/false): the upsert takes this value verbatim, so omission would silently disable a live config. At most one enabled config per tenant; enabling a non-dry_run provider requires key_id + key_secret + webhook_secret.' },
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
  PaymentGatewayRefundReconciliationListResponse: envelope('PaymentGatewayRefundReconciliationList'),
  PaymentGatewayRefundRecoveryListResponse: envelope('PaymentGatewayRefundReconciliationList'),
  PaymentGatewayConfigListResponse: envelope('PaymentGatewayConfigList'),
  PaymentGatewayConfigViewResponse: envelope('PaymentGatewayConfigView'),
  PaymentGatewayWebhookAckResponse: envelope('PaymentGatewayWebhookAck'),
};

export const operations = {
  'POST /api/v1/billing/gateway/orders': {
    description:
      'Creates a provider payment order (Razorpay order or deterministic dry_run order) tied to an invoice or an existing payment link, returning the checkout bootstrap (provider order id + publishable key id — never a secret). Requires Idempotency-Key (scope payment_gateway_order). The local intent survives a 5xx while the transport envelope is released, so an exact retry recovers by its provider receipt. 403 PAYMENT_GATEWAY_DISABLED until the tenant gateway is effectively enabled; a PATIENT caller may only pay their own bills.',
    parameters: [idempotencyHeader],
    security: authenticatedSecurity,
    request: 'PaymentGatewayOrderCreateRequest',
    response: 'PaymentGatewayOrderCheckoutResponse',
    additionalResponses: {
      400: errorResponse('Malformed request or missing/invalid Idempotency-Key.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('The payment gateway is disabled or the caller does not own the payable subject.'),
      409: errorResponse('The idempotency key or provider order evidence conflicts with an existing intent.'),
      422: errorResponse('The Idempotency-Key was reused with a different request body.'),
      502: errorResponse('The provider response was unavailable or lacked exact order evidence.'),
      503: errorResponse('The durable payment order intent could not be stored or recovered.'),
      500: errorResponse('An internal persistence or billing error prevented order creation.'),
    },
  },
  'GET /api/v1/billing/gateway/orders/{id}': {
    description:
      'Gateway order status poll (created → attempted → paid | failed | cancelled | expired | requires_reconciliation). A PATIENT caller sees only their own orders; a paid order carries the billing_payments id booked by collectPayment in the same transaction.',
    response: 'PaymentGatewayOrderResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      401: errorResponse('API-key and bearer authentication are required.'),
      404: errorResponse('The order was not found or is not visible to this patient.'),
      500: errorResponse('The order could not be read because of an internal persistence failure.'),
    },
  },
  'POST /api/v1/billing/gateway/orders/{id}/cancel': {
    description:
      'Cancels a gateway order still in created/attempted. A capture webhook that arrives later still books the provider money (the provider capture is authoritative); cancel only stops the local checkout window.',
    response: 'PaymentGatewayOrderResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      400: errorResponse('The order is not cancellable in its current status.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      404: errorResponse('The order was not found or is not visible to this patient.'),
      500: errorResponse('The cancellation could not be persisted.'),
    },
  },
  'GET /api/v1/billing/gateway/reconciliation': {
    description:
      'Admin work queue of requires_reconciliation orders — captures the provider took that automation could not book (voided invoice, amount drift). Unresolved rows only by default; include_resolved=true also returns operator-stamped rows.',
    response: 'PaymentGatewayReconciliationListResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority is required.'),
      500: errorResponse('The reconciliation queue could not be read.'),
    },
  },
  'POST /api/v1/billing/gateway/orders/{id}/reconcile': {
    description:
      'Admin resolution stamp for a requires_reconciliation order: atomically records reconciled_at, a required note, and the authenticated same-tenant reconciled_by actor, then writes an audit row. The order status stays requires_reconciliation (694 has no reconciled status) — stamped rows drop out of the default work-queue listing.',
    request: 'PaymentGatewayOrderReconcileRequest',
    response: 'PaymentGatewayOrderResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      400: errorResponse('The reconciliation note was missing or outside 10-500 characters.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority or a same-tenant reconciliation actor was not verified.'),
      404: errorResponse('The gateway order was not found.'),
      409: errorResponse('The order is not awaiting reconciliation or was already reconciled.'),
      500: errorResponse('The reconciliation stamp or its audit evidence could not be persisted.'),
    },
  },
  'POST /api/v1/billing/gateway/refunds': {
    description:
      'Executes an APPROVED billing_refunds row against the exact supplied paid gateway order after matching invoice, payer, payment mode, and original provider config. A durable provider idempotency key and exclusive gateway payout claim are committed before the external refund request. The HTTP idempotency envelope is released on 5xx so an exact retry reaches that same durable provider intent and key. Execution/evidence leg only: refund authority stays in the billingV2 raiseRefund → approveRefund lifecycle. Exact provider evidence returned synchronously with status processed completes it immediately through the trusted markGatewayRefundPaid path; otherwise the signed refund.processed webhook completes the same path. Finance/cashier/admin roles; Idempotency-Key required (scope payment_gateway_refund).',
    parameters: [idempotencyHeader],
    security: authenticatedSecurity,
    request: 'PaymentGatewayRefundCreateRequest',
    response: 'PaymentGatewayRefundResponse',
    additionalResponses: {
      400: errorResponse('Malformed request, missing/invalid Idempotency-Key, or refund/payment evidence mismatch.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('The payment gateway is disabled or the caller lacks refund execution authority.'),
      409: errorResponse('Another payout rail or gateway execution already owns this billing refund.'),
      422: errorResponse('The Idempotency-Key was reused with a different request body.'),
      502: errorResponse('The provider response was unavailable or lacked exact refund evidence.'),
      503: errorResponse('The durable gateway refund intent could not be stored or recovered.'),
      500: errorResponse('An internal billing, ledger, or persistence failure prevented refund execution.'),
    },
  },
  'GET /api/v1/billing/gateway/refunds/{id}/candidates': {
    description:
      'Lists exact paid gateway orders eligible to fund one APPROVED billing refund. Candidates must match tenant, patient, invoice, payment mode, provider configuration, and remaining captured headroom. This read does not claim a payout rail or contact the provider.',
    response: 'PaymentGatewayRefundCandidateListResponse',
    security: authenticatedSecurity,
    pathParameters: { id: { type: 'integer', minimum: 1 } },
    additionalResponses: {
      400: errorResponse('The refund identifier was malformed or the refund is not invoice-linked.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('The gateway is disabled or the caller lacks refund execution authority.'),
      404: errorResponse('The billing refund was not found.'),
      409: errorResponse('The refund is not approved or is already owned by the manual payout rail.'),
      500: errorResponse('Eligible payment sources could not be read.'),
    },
  },
  'GET /api/v1/billing/gateway/refund-reconciliation': {
    description:
      'Admin work queue of provider refund legs parked in requires_reconciliation. Unresolved rows only by default; include_resolved=true includes operator-stamped history. Provider idempotency keys remain write-only.',
    response: 'PaymentGatewayRefundReconciliationListResponse',
    security: authenticatedSecurity,
    parameters: [
      {
        name: 'include_resolved', in: 'query', required: false,
        schema: { type: 'boolean', default: false },
        description: 'Include terminal operator-reviewed provider_failed history.',
      },
      {
        name: 'limit', in: 'query', required: false,
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      {
        name: 'offset', in: 'query', required: false,
        schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
      },
    ],
    additionalResponses: {
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority is required.'),
      500: errorResponse('The refund reconciliation queue could not be read.'),
    },
  },
  'GET /api/v1/billing/gateway/refund-recovery': {
    description:
      'Finance/cashier/admin provider-confirmation queue for unresolved gateway refund executions. Each unresolved leg exposes its durable retry projection, operator task, and SLA state while keeping provider idempotency credentials write-only. include_terminal=true includes provider-confirmed history. A provider refund id is correlation only and never means success.',
    response: 'PaymentGatewayRefundRecoveryListResponse',
    security: authenticatedSecurity,
    parameters: [
      {
        name: 'include_terminal', in: 'query', required: false,
        schema: { type: 'boolean', default: false },
        description: 'Include provider-confirmed terminal recovery projections.',
      },
      {
        name: 'limit', in: 'query', required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      {
        name: 'offset', in: 'query', required: false,
        schema: { type: 'integer', minimum: 0, default: 0 },
      },
    ],
    additionalResponses: {
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Finance, cashier, or administrator refund authority is required.'),
      500: errorResponse('The refund recovery queue could not be read.'),
    },
  },
  'POST /api/v1/billing/gateway/refunds/{id}/recover': {
    description:
      'Requests one fenced recovery attempt for the exact durable gateway refund. Default OFF behind PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true and still requires the existing deployment, tenant, exact provider-config, and credential gates. A missing provider id replays only the original provider request identity; otherwise recovery polls the authoritative provider GET refund endpoint. Only exact status=processed evidence may settle billing; exact status=failed evidence projects terminal failure. Both terminal provider outcomes close the task/SLA, while pending, mismatched, missing-authority, and exhausted outcomes remain explicit and unresolved. Idempotency-Key required (scope payment_gateway_refund_recovery).',
    parameters: [idempotencyHeader],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    response: 'PaymentGatewayRefundResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      400: errorResponse('The refund id or Idempotency-Key was invalid.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Recovery is not activated, provider authority is unavailable, or the caller lacks refund authority.'),
      409: errorResponse('The refund is already leased or its durable request identity/status conflicts.'),
      422: errorResponse('The Idempotency-Key was reused with a different recovery request.'),
      502: errorResponse('The provider status endpoint did not return usable evidence.'),
      503: errorResponse('The recovery task/SLA authority is unavailable.'),
      500: errorResponse('The recovery attempt could not be persisted.'),
    },
  },
  'POST /api/v1/billing/gateway/refunds/{id}/reconcile': {
    description:
      'Admin structured review for a requires_reconciliation provider refund. provider_processed, provider_pending, and provider_status_unknown record attributed evidence while keeping the recovery task/SLA open and the refund pollable. A processed observation requires an independent reviewer but cannot settle billing or close the obligation. provider_failed becomes a terminal manual closure only when the execution is already bound to an exact validated provider_refund_id; without that identifier it remains open and replacement-blocking so late processed evidence can still correlate. Terminal failure requires a reviewer independent of the refund raiser, approver, and provider initiator. Only exact evidence obtained through the trusted provider adapter may project financial success. The two operator-terminal dispositions stay on the local settlement rail and take note + evidence_reference instead: provider_not_refunded requires attributable provider evidence plus recovery_path=gateway_retry; it closes the execution as failed while retaining integrated-gateway billing ownership. manual_settled requires the exact provider refund identifier and settles billing plus the execution through the trusted gateway payout path. Integrated electronic refunds cannot be released to manual payout. Actor, note, evidence, disposition, and outcome remain in metadata. Exact signed terminal evidence is still evaluated and cannot be ignored by an earlier note.',
    request: 'PaymentGatewayRefundReconcileRequest',
    response: 'PaymentGatewayRefundResponse',
    security: authenticatedSecurity,
    pathParameters: {
      id: { type: 'integer', minimum: 1, maximum: 2147483647 },
    },
    additionalResponses: {
      400: errorResponse('The disposition, structured evidence, or the operator-terminal note / evidence_reference / recovery_path tuple was missing, invalid, future-dated, mixed across the two rails, or internally inconsistent.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority, same-tenant identity, or the independent-reviewer policy was not satisfied.'),
      404: errorResponse('The gateway refund was not found.'),
      409: errorResponse('The refund is not awaiting reconciliation, its exact terminal provider id is unavailable, a provider recovery lease is live, or it was already reconciled.'),
      500: errorResponse('The structured reconciliation review or its audit evidence could not be persisted.'),
    },
  },
  'GET /api/v1/billing/gateway/config': {
    description:
      'Admin read of the tenant provider configs plus the env/tenant gate states. Secrets are write-only — reads expose has_key_secret / has_webhook_secret booleans and the tenant webhook path only.',
    response: 'PaymentGatewayConfigListResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority is required.'),
      500: errorResponse('Gateway configuration could not be read.'),
    },
  },
  'PUT /api/v1/billing/gateway/config': {
    description:
      'Admin upsert of the per-tenant provider config (one row per provider+environment; at most one enabled per tenant). key_secret / webhook_secret are write-only and stored as encryptField() ciphertext; enabling a non-dry_run provider without credentials is rejected. Enabling the exact config atomically requeues matching authority-blocked refund recoveries with their audit/outbox transition; if that transition cannot persist, config enablement rolls back. The webhook routing token is minted once and stays stable.',
    request: 'PaymentGatewayConfigUpsertRequest',
    response: 'PaymentGatewayConfigViewResponse',
    security: authenticatedSecurity,
    additionalResponses: {
      400: errorResponse('Provider configuration or required live credentials were invalid.'),
      401: errorResponse('API-key and bearer authentication are required.'),
      403: errorResponse('Administrator authority is required.'),
      409: errorResponse('Another provider configuration already owns the tenant live slot.'),
      500: errorResponse('Gateway configuration could not be persisted.'),
    },
  },
  'POST /webhooks/payments/{webhookToken}': {
    description:
      'Public provider webhook intake (pre-auth mount). The opaque URL token resolves the tenant fail-closed (unknown → 404, nothing written); authenticity is HMAC-SHA256 over the raw body vs x-razorpay-signature. A disabled config or retired signing secret is inbound-only; retired credentials settle only nonterminal intents bound to their exact credential version, config, provider, and environment before rotation. Deliveries are recorded durably before processing; the UNIQUE (tenant, provider, provider_event_id) key plus a cross-replica replay claim collapse redeliveries. Captures require exact unmasked provider payment id, integer amount, and currency before collectPayment can run. A 2xx means the event status was durably written; intake, processing, or final-status persistence failures return 5xx so the provider retries.',
    security: [],
    pathParameters: {
      webhookToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' },
    },
    parameters: [
      {
        name: 'x-razorpay-signature', in: 'header', required: true,
        schema: { type: 'string' },
        description: 'HMAC-SHA256 signature over the exact raw request body.',
      },
      {
        name: 'x-razorpay-event-id', in: 'header', required: true,
        schema: { type: 'string', minLength: 1, maxLength: 160 },
        description: 'Provider-assigned durable delivery identity.',
      },
    ],
    response: 'PaymentGatewayWebhookAckResponse',
    additionalResponses: {
      400: errorResponse('The signed raw body or required provider event identity was missing.'),
      401: errorResponse('The webhook signature could not be verified.'),
      404: errorResponse('The routing token or retired-credential intent binding was not found.'),
      500: errorResponse('Webhook processing or its durable final-status write failed; the provider must retry.'),
      503: errorResponse('Replay protection or durable webhook intake was unavailable; the provider must retry.'),
    },
  },
};
