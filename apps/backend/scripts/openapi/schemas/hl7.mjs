import { envelope } from './_helpers.mjs';

const ACK_MEDIA_TYPE = 'application/hl7-v2';
const CANONICAL_POSITIVE_DECIMAL = '^[1-9][0-9]*$';
const CANONICAL_NON_NEGATIVE_DECIMAL = '^(0|[1-9][0-9]*)$';
const LOWERCASE_SHA256 = '^[0-9a-f]{64}$';
const LOWERCASE_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const EXPLICIT_OFFSET_TIMESTAMP =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?' +
  '(?:Z|\\+(?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00)|' +
  '-(?:(?:0[1-9]|1[0-3]):[0-5][0-9]|00:(?:0[1-9]|[1-5][0-9])|14:00))$';
const HL7_FEED_MESSAGE_TYPES = ['ADT^A01', 'ADT^A02', 'ADT^A03', 'ORM^O01', 'ORU^R01'];

const feedErrorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Hl7FeedErrorResponse' },
    },
  },
});

const authenticatedFeedErrors = {
  401: feedErrorResponse('The API key or bearer access token was missing, invalid, expired, or revoked.'),
  403: feedErrorResponse('The caller is not an administrator or integration administrator.'),
  429: feedErrorResponse('The authenticated caller exceeded the route rate limit.'),
  500: feedErrorResponse('The feed-management operation failed without exposing internal details.'),
};

const recoveryHl7Message = {
  type: 'string',
  minLength: 1,
  maxLength: 2_000_000,
  'x-vhhealth-maxUtf8Bytes': 2_000_000,
  description:
    'Exact HL7v2 message represented as a JSON string. Runtime enforcement measures the ' +
    'UTF-8 bytes before parsing and rejects messages over 2,000,000 bytes; maxLength is a ' +
    'compatible character-length guard, not a substitute for that byte count.',
};

const liveHl7Message = {
  type: 'string',
  minLength: 1,
  maxLength: 1_048_576,
  'x-vhhealth-maxRequestBytes': 1_048_576,
  description:
    'Legacy live HL7v2 message. The complete JSON request retains the deployment HTTP body ' +
    'limit (1 MiB by default); the larger recovery-only parser does not widen this branch.',
};

const explicitOffsetTimestamp = {
  type: 'string',
  format: 'date-time',
  pattern: EXPLICIT_OFFSET_TIMESTAMP,
};

const rawAckResponse = description => ({
  description,
  content: {
    [ACK_MEDIA_TYPE]: {
      schema: { $ref: '#/components/schemas/Hl7V2Ack' },
    },
  },
});

const rawAckOrLegacyJsonResponse = description => ({
  description,
  content: {
    [ACK_MEDIA_TYPE]: {
      schema: { $ref: '#/components/schemas/Hl7V2Ack' },
    },
    'application/json': {
      schema: { $ref: '#/components/schemas/Hl7LegacyJsonError' },
    },
  },
});

const legacyJsonResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Hl7LegacyJsonError' },
    },
  },
});

export const schemas = {
  Hl7FeedErrorResponse: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: true,
        required: ['success', 'message'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string' },
          code: { type: 'string' },
          requestId: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      {
        type: 'object',
        additionalProperties: true,
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: true,
        required: ['error'],
        not: { required: ['success'] },
        properties: {
          error: { type: 'string' },
        },
        description: 'Global API-key validation failure before route dispatch.',
      },
    ],
  },
  Hl7FeedSubscription: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'name',
      'endpoint_url',
      'message_types',
      'is_active',
      'auth_header_configured',
      'created_at',
    ],
    properties: {
      id: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
      tenant_id: { type: 'string', format: 'uuid' },
      name: { type: 'string', minLength: 1, maxLength: 120 },
      endpoint_url: { type: 'string', format: 'uri' },
      message_types: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', enum: HL7_FEED_MESSAGE_TYPES },
      },
      is_active: { type: 'boolean' },
      auth_header_configured: { type: 'boolean' },
      last_delivery_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
    description:
      'Tenant-scoped receiver configuration. The credential value is never returned; only its configured state is visible.',
  },
  Hl7FeedSubscriptionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'endpoint_url'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      endpoint_url: {
        type: 'string',
        format: 'uri',
        pattern: '^https?://',
        description:
          'Receiver URL. Credential-bearing query parameters are rejected; use auth_header for receiver authorization.',
      },
      auth_header: {
        type: 'string',
        nullable: true,
        writeOnly: true,
        description:
          'Receiver Authorization header. Omit to preserve the stored credential on an existing subscription; send null or an empty string to clear it; send a non-empty value to rotate it.',
      },
      message_types: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', enum: HL7_FEED_MESSAGE_TYPES },
        description:
          'Complete receiver scope. Omit to preserve an existing subscription scope; a new subscription defaults to ADT A01/A02/A03 and ORU R01.',
      },
    },
  },
  Hl7FeedSubscriptionListResult: {
    type: 'object',
    additionalProperties: false,
    required: ['subscriptions', 'count'],
    properties: {
      subscriptions: {
        type: 'array',
        items: { $ref: '#/components/schemas/Hl7FeedSubscription' },
      },
      count: { type: 'integer', minimum: 0 },
    },
  },
  Hl7FeedSubscriptionListResponse: envelope('Hl7FeedSubscriptionListResult'),
  Hl7FeedSubscriptionResult: {
    type: 'object',
    additionalProperties: false,
    required: ['subscription'],
    properties: {
      subscription: { $ref: '#/components/schemas/Hl7FeedSubscription' },
    },
  },
  Hl7FeedSubscriptionResponse: envelope('Hl7FeedSubscriptionResult'),
  Hl7FeedDeactivatedSubscription: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name', 'is_active'],
    properties: {
      id: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
      name: { type: 'string' },
      is_active: { type: 'boolean', enum: [false] },
    },
  },
  Hl7FeedDeactivationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['subscription'],
    properties: {
      subscription: { $ref: '#/components/schemas/Hl7FeedDeactivatedSubscription' },
    },
  },
  Hl7FeedDeactivationResponse: envelope('Hl7FeedDeactivationResult'),
  Hl7FeedMessage: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'subscription_id',
      'subscription_name',
      'message_type',
      'status',
      'attempts',
      'transport_state',
      'acknowledgement_state',
      'send_authority',
      'created_at',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      subscription_id: { type: 'integer', minimum: 1 },
      subscription_name: { type: 'string' },
      message_type: { type: 'string', enum: HL7_FEED_MESSAGE_TYPES },
      message_control_id: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: ['queued', 'claimed', 'sent', 'failed', 'dead', 'reconciliation_required'],
      },
      attempts: { type: 'integer', minimum: 0 },
      last_error: { type: 'string', nullable: true },
      next_attempt_at: { type: 'string', format: 'date-time' },
      sent_at: { type: 'string', format: 'date-time', nullable: true },
      source_table: { type: 'string', nullable: true },
      source_id: { type: 'string', nullable: true },
      source_event_key: { type: 'string' },
      payload_sha256: { type: 'string', pattern: LOWERCASE_SHA256 },
      transport_state: { type: 'string' },
      acknowledgement_state: { type: 'string' },
      send_authority: { type: 'string' },
      recovery_inbox_id: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  Hl7FeedMessageListResult: {
    type: 'object',
    additionalProperties: false,
    required: ['messages', 'count'],
    properties: {
      messages: { type: 'array', items: { $ref: '#/components/schemas/Hl7FeedMessage' } },
      count: { type: 'integer', minimum: 0 },
    },
  },
  Hl7FeedMessageListResponse: envelope('Hl7FeedMessageListResult'),
  Hl7FeedDeliveryRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
    },
  },
  Hl7FeedDeliveryResult: {
    type: 'object',
    additionalProperties: false,
    required: ['picked', 'acknowledged', 'rejected', 'uncertain', 'deferred', 'expired'],
    properties: {
      picked: { type: 'integer', minimum: 0 },
      acknowledged: { type: 'integer', minimum: 0 },
      rejected: { type: 'integer', minimum: 0 },
      uncertain: { type: 'integer', minimum: 0 },
      deferred: { type: 'integer', minimum: 0 },
      expired: { type: 'integer', minimum: 0 },
    },
  },
  Hl7FeedDeliveryResponse: envelope('Hl7FeedDeliveryResult'),
  Hl7LegacyJsonError: {
    type: 'object',
    additionalProperties: true,
    properties: {
      success: { type: 'boolean', enum: [false] },
      code: { type: 'string' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    anyOf: [
      { required: ['message'] },
      { required: ['error'] },
    ],
    description:
      'Preserved envelope-less legacy error shape. Recovery-marked requests use the raw HL7 ACK media type.',
  },
  Hl7I03ClockEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['source_clock_id', 'synchronized_at', 'maximum_error_ms'],
    properties: {
      source_clock_id: { type: 'string', minLength: 1, maxLength: 120 },
      synchronized_at: explicitOffsetTimestamp,
      maximum_error_ms: { type: 'integer', minimum: 0, maximum: 300_000 },
    },
    description:
      'Closed sender-clock evidence. Runtime validation requires synchronization not to ' +
      'post-date sender receipt and applies maximum_error_ms to the occurrence-time fence.',
  },
  Hl7I03RecoveryEnvelope: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema',
      'interface_family',
      'arrival_class',
      'tenant_id',
      'signing_credential_id',
      'offset_id',
      'source_partition',
      'generation',
      'source_position',
      'source_token',
      'predecessor_token',
      'duplicate_key',
      'message_family',
      'message_type',
      'trigger_event',
      'message_control_id',
      'message_sha256',
      'source_observed_at',
      'source_received_at',
      'clock_evidence',
    ],
    properties: {
      schema: { type: 'string', enum: ['vhhealth.i03.adt-orm-sequence/v1'] },
      interface_family: { type: 'string', enum: ['I03'] },
      arrival_class: { type: 'string', enum: ['recovery_backlog'] },
      tenant_id: { type: 'string', format: 'uuid', pattern: LOWERCASE_UUID },
      signing_credential_id: {
        type: 'string',
        pattern: CANONICAL_POSITIVE_DECIMAL,
        maxLength: 10,
        'x-vhhealth-maximumDecimal': '2147483647',
        description:
          'Canonical positive decimal DB credential id. Runtime enforces the PostgreSQL ' +
          'integer ceiling of 2147483647 without converting the wire value through Number.',
      },
      offset_id: { type: 'string', format: 'uuid', pattern: LOWERCASE_UUID },
      source_partition: {
        type: 'string',
        pattern: '^i03/credential/[1-9][0-9]*/family/(?:adt|orm)$',
        maxLength: 160,
      },
      generation: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
      source_position: {
        type: 'string',
        pattern: CANONICAL_NON_NEGATIVE_DECIMAL,
        maxLength: 19,
        'x-vhhealth-maximumDecimal': '9223372036854775807',
        description:
          'Canonical non-negative decimal position. Runtime enforces the PostgreSQL bigint ' +
          'ceiling of 9223372036854775807 without lossy JSON-number coercion.',
      },
      source_token: { type: 'string', pattern: LOWERCASE_SHA256 },
      predecessor_token: { type: 'string', pattern: LOWERCASE_SHA256 },
      duplicate_key: { type: 'string', pattern: LOWERCASE_SHA256 },
      message_family: { type: 'string', enum: ['adt', 'orm'] },
      message_type: { type: 'string', enum: ['ADT', 'ORM'] },
      trigger_event: { type: 'string', enum: ['A01', 'A02', 'A03', 'O01'] },
      message_control_id: { type: 'string', minLength: 1, maxLength: 199 },
      message_sha256: { type: 'string', pattern: LOWERCASE_SHA256 },
      source_observed_at: explicitOffsetTimestamp,
      source_received_at: explicitOffsetTimestamp,
      clock_evidence: { $ref: '#/components/schemas/Hl7I03ClockEvidence' },
    },
    oneOf: [
      {
        required: ['message_family', 'message_type', 'trigger_event'],
        properties: {
          source_partition: {
            type: 'string',
            pattern: '^i03/credential/[1-9][0-9]*/family/adt$',
          },
          message_family: { type: 'string', enum: ['adt'] },
          message_type: { type: 'string', enum: ['ADT'] },
          trigger_event: { type: 'string', enum: ['A01', 'A02', 'A03'] },
        },
      },
      {
        required: ['message_family', 'message_type', 'trigger_event'],
        properties: {
          source_partition: {
            type: 'string',
            pattern: '^i03/credential/[1-9][0-9]*/family/orm$',
          },
          message_family: { type: 'string', enum: ['orm'] },
          message_type: { type: 'string', enum: ['ORM'] },
          trigger_event: { type: 'string', enum: ['O01'] },
        },
      },
    ],
    description:
      'Closed, HMAC-bound I03 recovery evidence. Every identity is verified against the ' +
      'parsed message, active DB credential, canonical offset, and server-derived partition; ' +
      'effect disposition is server-owned and is never accepted from the sender.',
  },
  Hl7InboundLiveRequest: {
    type: 'object',
    additionalProperties: true,
    required: ['message'],
    properties: {
      message: liveHl7Message,
    },
    not: { required: ['recovery'] },
    description:
      'Compatible legacy live request. Additional legacy properties remain tolerated, but an ' +
      'own recovery property irrevocably selects the closed recovery branch.',
  },
  Hl7InboundRecoveryRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'recovery'],
    properties: {
      message: recoveryHl7Message,
      recovery: { $ref: '#/components/schemas/Hl7I03RecoveryEnvelope' },
    },
    description:
      'Closed I03 request containing only the exact message and its signed recovery evidence.',
  },
  Hl7InboundReceiveRequest: {
    type: 'object',
    required: ['message'],
    properties: {
      message: recoveryHl7Message,
      recovery: { $ref: '#/components/schemas/Hl7I03RecoveryEnvelope' },
    },
    allOf: [
      {
        oneOf: [
          { $ref: '#/components/schemas/Hl7InboundLiveRequest' },
          { $ref: '#/components/schemas/Hl7InboundRecoveryRequest' },
        ],
      },
    ],
    description:
      'Either the compatible legacy live request or the closed I03 recovery request; the ' +
      'variants cannot overlap because the live branch forbids an own recovery property.',
  },
  Hl7V2Ack: {
    type: 'string',
    minLength: 1,
    description:
      'Raw HL7v2 ACK bytes containing MSH and MSA. A committed I03 success or exact handled ' +
      'retry returns the exact stored bytes and intended HTTP status without regeneration.',
  },
};

export const operations = {
  'GET /api/v1/hl7-feeds/subscriptions': {
    summary: 'List outbound HL7 feed subscriptions',
    description:
      'Returns the authenticated tenant subscriptions to administrators and integration administrators. Stored Authorization headers are never returned.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    response: 'Hl7FeedSubscriptionListResponse',
    responseDescription: 'Tenant-scoped subscriptions and credential-presence indicators.',
    additionalResponses: authenticatedFeedErrors,
  },
  'POST /api/v1/hl7-feeds/subscriptions': {
    summary: 'Create or update an outbound HL7 feed subscription',
    description:
      'Upserts by tenant and name. Omitted credential and message-type fields preserve the existing values atomically; explicit credential null or empty clears it, and an explicit non-empty message-type array replaces the complete receiver scope.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    request: 'Hl7FeedSubscriptionRequest',
    response: 'Hl7FeedSubscriptionResponse',
    responseStatus: 201,
    responseDescription: 'The created or updated subscription without credential material.',
    additionalResponses: {
      400: feedErrorResponse('The name, endpoint URL, receiver target, or message-type scope was invalid.'),
      ...authenticatedFeedErrors,
    },
  },
  'DELETE /api/v1/hl7-feeds/subscriptions/{id}': {
    summary: 'Deactivate an outbound HL7 feed subscription',
    description:
      'Soft-deactivates the exact positive subscription id within the authenticated tenant. It does not release held outbound messages.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    pathParameters: {
      id: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    },
    response: 'Hl7FeedDeactivationResponse',
    responseDescription: 'The deactivated subscription identity.',
    additionalResponses: {
      400: feedErrorResponse('The subscription id was not a canonical positive PostgreSQL integer.'),
      404: feedErrorResponse('No subscription with that id exists in the authenticated tenant.'),
      ...authenticatedFeedErrors,
    },
  },
  'GET /api/v1/hl7-feeds/messages': {
    summary: 'List outbound HL7 delivery-ledger messages',
    description:
      'Returns tenant-scoped transport, acknowledgement, send-authority, and recovery state without returning HL7 payload bytes.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    parameters: [
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: ['queued', 'claimed', 'sent', 'failed', 'dead', 'reconciliation_required'],
        },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    ],
    response: 'Hl7FeedMessageListResponse',
    responseDescription: 'Tenant-scoped delivery-ledger messages and count.',
    additionalResponses: authenticatedFeedErrors,
  },
  'POST /api/v1/hl7-feeds/deliver-now': {
    summary: 'Run one bounded outbound HL7 delivery pass',
    description:
      'Claims only ledger-authorized due messages in order and records transport plus correlated MSA evidence. This operation cannot release an owner-held or reconciliation-required message.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    request: 'Hl7FeedDeliveryRequest',
    requestRequired: false,
    response: 'Hl7FeedDeliveryResponse',
    responseDescription: 'Counts for the completed bounded delivery pass.',
    additionalResponses: authenticatedFeedErrors,
  },
  'POST /api/v1/hl7/receive': {
    summary: 'Receive a signed live or I03 recovery HL7v2 message',
    description:
      'The legacy request remains an HMAC-authenticated live path. Supplying an own recovery ' +
      'property irrevocably selects I03: it requires an active DB-backed HL7 credential, binds ' +
      'the exact message and every closed-envelope field into the HMAC, and admits new backlog ' +
      'work only for the precise canonical offset in replaying state. Environment-secret ' +
      'credentials are legacy-only. Omitting recovery cannot bypass a paused, replaying, or ' +
      'reconciliation-required enrolled offset; the downgrade fence returns a retryable ACK ' +
      'before live mutation. An exact handled retry returns the exact stored ACK bytes and ' +
      'stored status, including after the offset reaches ready. Accepted recovery creates only ' +
      'an encrypted immutable receipt and no-SLA human-review task: it never directly creates, ' +
      'changes, transfers, or discharges an admission and never creates or changes an ' +
      'investigation order.',
    parameters: [
      {
        name: 'X-HL7-Message-Id',
        in: 'header',
        required: false,
        description:
          'Fresh signed request identifier. Mandatory for recovery; the legacy branch may fall ' +
          'back to X-Request-Id or MSH-10 for compatibility.',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
      {
        name: 'X-HL7-Timestamp',
        in: 'header',
        required: true,
        description: 'Fresh timestamp covered by the canonical HMAC payload.',
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'X-HL7-Signature',
        in: 'header',
        required: true,
        description:
          'HMAC-SHA256 signature. Recovery signs the contract identifier, exact message ' +
          'SHA-256, and canonical fingerprint of all 20 recovery fields.',
        schema: { type: 'string', minLength: 1 },
      },
    ],
    request: 'Hl7InboundReceiveRequest',
    response: 'Hl7V2Ack',
    responseContentType: ACK_MEDIA_TYPE,
    responseDescription:
      'Raw AA, AE, or AR ACK. I03 AA means durable acceptance for reconciliation, not a live clinical effect.',
    additionalResponses: {
      400: rawAckOrLegacyJsonResponse(
        'Malformed HL7 or invalid closed recovery contract (AR or AE); malformed envelope-less JSON preserves the legacy JSON error',
      ),
      401: rawAckOrLegacyJsonResponse(
        'Missing, stale, replayed, or invalid HMAC credentials (AR); envelope-less API-key rejection preserves the legacy JSON error',
      ),
      403: rawAckResponse('Authenticated credential and tenant evidence do not agree (AR)'),
      404: rawAckResponse(
        'Legacy live branch only: the referenced patient is not registered at this facility (AE)',
      ),
      409: rawAckResponse(
        'Recovery envelope, marker, predecessor, position, duplicate, or downgrade fence conflict (AE)',
      ),
      413: legacyJsonResponse(
        'Request exceeds the applicable parser body limit before branch selection; the preserved response is the legacy JSON error',
      ),
      429: rawAckOrLegacyJsonResponse(
        'Authenticated API-key or fallback ingress rate limit exceeded; retry later (AE); envelope-less throttling preserves the legacy JSON error',
      ),
      500: rawAckOrLegacyJsonResponse(
        'Processing or atomic late-disposition failure (AE); envelope-less configuration and unhandled failures preserve the legacy JSON error',
      ),
      503: rawAckResponse('Credential, database, or recovery substrate is unavailable (AE)'),
    },
  },
};
