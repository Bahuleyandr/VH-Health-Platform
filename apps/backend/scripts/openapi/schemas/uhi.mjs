// apps/backend/scripts/openapi/schemas/uhi.mjs
// UHI (Unified Health Interface / DHP-beckn) adapter (migration 705):
// provider-side webhook legs (search/init/confirm/status/cancel) on a public
// signature-verified mount, plus the admin evidence-ledger list. Ship-disabled
// (UHI_ENABLED + tenants.settings.uhi), sandbox default.
import { envelope } from './_helpers.mjs';

const UHI_ACTIONS = [
  'search', 'on_search', 'init', 'on_init', 'confirm', 'on_confirm',
  'status', 'on_status', 'cancel', 'on_cancel',
];

export const schemas = {
  UhiContext: {
    type: 'object',
    required: ['transaction_id', 'message_id'],
    properties: {
      domain: { type: 'string', nullable: true },
      country: { type: 'string', nullable: true },
      city: { type: 'string', nullable: true },
      action: { type: 'string', nullable: true },
      transaction_id: {
        type: 'string',
        maxLength: 120,
        description: 'Spans the whole search→init→confirm journey.',
      },
      message_id: { type: 'string', maxLength: 120 },
      bpp_id: {
        type: 'string',
        maxLength: 200,
        nullable: true,
        description: 'Provider (HSP) subscriber id — resolves the tenant before any write.',
      },
      bap_id: { type: 'string', maxLength: 200, nullable: true },
      bap_uri: { type: 'string', maxLength: 500, nullable: true },
      timestamp: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  UhiInboundMessage: {
    type: 'object',
    required: ['context'],
    properties: {
      context: { $ref: '#/components/schemas/UhiContext' },
      message: {
        type: 'object',
        additionalProperties: true,
        description: 'Beckn message body (intent for search, order for init/confirm, order_id for status/cancel).',
      },
    },
  },

  UhiAckPayload: {
    type: 'object',
    required: ['message'],
    properties: {
      message: {
        type: 'object',
        required: ['ack'],
        properties: {
          ack: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string', enum: ['ACK', 'NACK'] },
            },
          },
        },
      },
      error: {
        type: 'object',
        nullable: true,
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },

  UhiTransaction: {
    type: 'object',
    required: ['id', 'environment', 'transactionId', 'messageId', 'action', 'direction', 'status'],
    properties: {
      id: { type: 'integer' },
      environment: { type: 'string', enum: ['sandbox', 'production'] },
      transactionId: { type: 'string', maxLength: 120 },
      messageId: { type: 'string', maxLength: 120 },
      action: { type: 'string', enum: UHI_ACTIONS },
      direction: { type: 'string', enum: ['inbound', 'outbound'] },
      counterpartySubscriberId: { type: 'string', maxLength: 200, nullable: true },
      signatureVerified: { type: 'boolean' },
      verificationFailureReason: { type: 'string', maxLength: 300, nullable: true },
      status: { type: 'string', enum: ['received', 'processed', 'failed', 'rejected'] },
      ack: { type: 'string', enum: ['ACK', 'NACK'], nullable: true },
      errorCode: { type: 'string', maxLength: 80, nullable: true },
      errorMessage: { type: 'string', maxLength: 500, nullable: true },
      appointmentId: {
        type: 'integer',
        nullable: true,
        description: 'Set on the confirm leg after booking through the existing appointment service.',
      },
      receivedAt: { type: 'string', format: 'date-time', nullable: true },
      processedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  UhiTransactionListPayload: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: {
        type: 'boolean',
        description: 'False when the adapter is disabled (env kill switch or tenant setting) — the list is then empty rather than an error.',
      },
      transactions: { type: 'array', items: { $ref: '#/components/schemas/UhiTransaction' } },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
  },

  UhiAckResponse: envelope('UhiAckPayload'),
  UhiTransactionListResponse: envelope('UhiTransactionListPayload'),
};

const WEBHOOK_DESCRIPTION_SUFFIX = 'Public UHI network webhook (pre-auth mount): beckn ed25519 signature over the exact raw bytes, fail-closed tenant resolution from the provider id in the context, and durable replay dedupe on (tenant, environment, transaction_id, message_id, action) — a redelivered leg answers a replay-safe ACK without reprocessing. Disabled deployments/tenants answer 404 UHI_DISABLED with nothing stored.';

export const operations = {
  'POST /api/v1/uhi/search': {
    description: `Receives a UHI discovery intent and answers an on_search catalog of matching doctors and open slots. ${WEBHOOK_DESCRIPTION_SUFFIX}`,
    request: 'UhiInboundMessage',
    response: 'UhiAckResponse',
  },
  'POST /api/v1/uhi/init': {
    description: `Receives a UHI booking init, soft-validates the requested slot, and answers an on_init quote. No hold rows are created (thin adapter scope). ${WEBHOOK_DESCRIPTION_SUFFIX}`,
    request: 'UhiInboundMessage',
    response: 'UhiAckResponse',
  },
  'POST /api/v1/uhi/confirm': {
    description: `Receives a UHI booking confirm and books through the platform's existing appointment service (canonical clinical timeline + audit evidence inherited), stamping appointment correlation + booking snapshot on the evidence row, then answers on_confirm. Unregistered customers are NACKed (UHI_PATIENT_NOT_REGISTERED). ${WEBHOOK_DESCRIPTION_SUFFIX}`,
    request: 'UhiInboundMessage',
    response: 'UhiAckResponse',
  },
  'POST /api/v1/uhi/status': {
    description: `Answers on_status with the state of the booking confirmed under this transaction. ${WEBHOOK_DESCRIPTION_SUFFIX}`,
    request: 'UhiInboundMessage',
    response: 'UhiAckResponse',
  },
  'POST /api/v1/uhi/cancel': {
    description: `Cancels the booking confirmed under this transaction through the existing appointment transition path (canonical evidence inherited) and answers on_cancel. ${WEBHOOK_DESCRIPTION_SUFFIX}`,
    request: 'UhiInboundMessage',
    response: 'UhiAckResponse',
  },
  'GET /api/v1/admin/uhi/transactions': {
    description:
      'Lists the tenant\'s UHI protocol-leg evidence/dedupe ledger (inbound intents and outbound on_* callbacks) for ops debugging, filterable by status/action/transaction id. ADMIN or SUPER_ADMIN. Returns an enabled:false marker instead of erroring while the adapter is disabled.',
    response: 'UhiTransactionListResponse',
  },
};
