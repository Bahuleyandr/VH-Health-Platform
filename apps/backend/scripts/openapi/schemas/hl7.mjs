const ACK_MEDIA_TYPE = 'application/hl7-v2';
const CANONICAL_POSITIVE_DECIMAL = '^[1-9][0-9]*$';
const CANONICAL_NON_NEGATIVE_DECIMAL = '^(0|[1-9][0-9]*)$';
const LOWERCASE_SHA256 = '^[0-9a-f]{64}$';
const LOWERCASE_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const EXPLICIT_OFFSET_TIMESTAMP =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?' +
  '(?:Z|\\+(?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00)|' +
  '-(?:(?:0[1-9]|1[0-3]):[0-5][0-9]|00:(?:0[1-9]|[1-5][0-9])|14:00))$';

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
