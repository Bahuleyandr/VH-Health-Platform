import { envelope } from './_helpers.mjs';

const lateRecoveryProperties = {
  arrival_class: { type: 'string', enum: ['recovery_backlog'] },
  tenant_id: { type: 'string', format: 'uuid' },
  offset_id: { type: 'string', format: 'uuid' },
  source_partition: { type: 'string', minLength: 1, maxLength: 160 },
  generation: { type: 'integer', minimum: 1 },
  source_position: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
  source_token: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  predecessor_token: { type: 'string', minLength: 1, maxLength: 255 },
  duplicate_key: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  source_observed_at: { type: 'string', format: 'date-time' },
  source_received_at: { type: 'string', format: 'date-time' },
  clock_evidence: { type: 'object', minProperties: 1, additionalProperties: true },
};

const lateRecoveryRequired = [
  'schema', 'interface_family', 'arrival_class', 'tenant_id', 'offset_id',
  'source_partition', 'generation', 'source_position', 'source_token',
  'predecessor_token', 'duplicate_key', 'source_observed_at',
  'source_received_at', 'clock_evidence',
];

export const schemas = {
  LabAstmIngestRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['protocol', 'message'],
    properties: {
      protocol: {
        type: 'string',
        enum: ['astm_e1394'],
      },
      message: {
        type: 'string',
        minLength: 1,
      },
      analyzer_code: {
        type: 'string',
      },
      recovery: { $ref: '#/components/schemas/LabI02RecoveryEnvelope' },
    },
  },
  LabOruIngestRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        description: 'HL7 ORU^R01 payload. Local investigation references in ORC-2/OBR-2 must use VHINV-<positive PostgreSQL integer>. Bare numeric, malformed VHINV, and reserved VHBOOK identifiers are rejected. A VHINV-linked single-analyte message requires exact investigations.test_code equality with the OBR-4 and every OBX-3 code component. Unrecognized external alphanumeric identifiers remain unlinked shadow data.',
      },
      recovery: { $ref: '#/components/schemas/LabI01RecoveryEnvelope' },
    },
  },
  LabI01RecoveryEnvelope: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...lateRecoveryRequired,
      'trusted_sender_identity', 'message_control_id', 'message_sha256',
    ],
    properties: {
      ...lateRecoveryProperties,
      schema: { type: 'string', enum: ['vhhealth.i01.oru-sequence/v1'] },
      interface_family: { type: 'string', enum: ['I01'] },
      trusted_sender_identity: { type: 'string', minLength: 1, maxLength: 120 },
      message_control_id: { type: 'string', minLength: 1, maxLength: 100 },
      message_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
    description: 'Owner-authorized I01 backlog envelope. OBR-7 is the explicit occurrence authority; late results create a no-SLA human-review task and never retrospective pathway, SLA, or notification effects.',
  },
  LabI02RecoveryEnvelope: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...lateRecoveryRequired,
      'analyzer_id', 'analyzer_code', 'analyzer_sender_identity',
      'raw_message_sha256', 'astm_message_sha256',
    ],
    properties: {
      ...lateRecoveryProperties,
      schema: { type: 'string', enum: ['vhhealth.i02.astm-sequence/v1'] },
      interface_family: { type: 'string', enum: ['I02'] },
      analyzer_id: { type: 'integer', minimum: 1 },
      analyzer_code: { type: 'string', minLength: 1, maxLength: 120 },
      analyzer_sender_identity: { type: 'string', minLength: 1, maxLength: 120 },
      raw_message_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      astm_message_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
    description: 'Owner-authorized I02 backlog envelope. Source occurrence is explicit because ASTM carries no governed occurrence timestamp; canonical ASTM bytes bind replay identity.',
  },
  InvestigationResultRecordRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {},
      interpretation: { type: 'string', maxLength: 2000 },
      technician_notes: { type: 'string', maxLength: 1000 },
      re_run: { type: 'boolean' },
      re_run_reason: { type: 'string', minLength: 5 },
    },
  },
  LabPathologistSignoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['result_ids', 'decision'],
    properties: {
      result_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'integer', minimum: 1, maximum: 2147483647 },
      },
      decision: { type: 'string', enum: ['verified', 'corrected', 'amended'] },
      comments: { type: 'string', nullable: true },
      booking_id: { type: 'integer', minimum: 1, maximum: 2147483647, nullable: true },
      patient_uid: {
        type: 'string',
        format: 'uuid',
        nullable: true,
        description: 'Compatibility assertion only; ownership is derived from locked tenant rows.',
      },
    },
  },
  LabPathologistSignoff: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'episode_key', 'classification', 'result_snapshot_sha256', 'receipt'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      episode_key: { type: 'string', pattern: '^(investigation|booking):[1-9][0-9]*$' },
      classification: {
        type: 'string',
        enum: ['critical', 'abnormal', 'normal', 'indeterminate'],
      },
      result_snapshot_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      receipt: {
        type: 'object',
        required: ['idempotency_key', 'request_body_sha256'],
        properties: {
          idempotency_key: { type: 'string', nullable: true },
          request_body_sha256: { type: 'string', nullable: true, pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
  },
  LabPathologistSignoffResponse: envelope('LabPathologistSignoff'),
};

const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
};

export const operations = {
  'PUT /api/v1/investigations/{id}/results': {
    summary: 'Record technical investigation results',
    description: 'The authenticated current database actor is recorded as the technical result recorder. reviewed_by and other caller-supplied reviewer identities are rejected and this command does not constitute doctor countersignature.',
    request: 'InvestigationResultRecordRequest',
  },
  'POST /api/v1/lab/interface/ingest': {
    summary: 'Ingest an ASTM E1394 analyzer message',
    description: 'ASTM-only analyzer inbox. Optional I02 recovery adapts the migration-583 receipt and requires an owner-authorized high-water marker; recovered critical results create no retrospective SLA/pathway/notification effects. HL7 ORU messages must use /api/v1/lab/oru/ingest.',
    request: 'LabAstmIngestRequest',
  },
  'POST /api/v1/lab/results': {
    summary: 'Record a manual laboratory result',
    description: 'Requires a stable Idempotency-Key so retries cannot duplicate the result, canonical evidence, or critical-result obligations.',
    parameters: [idempotencyKeyParameter],
  },
  'POST /api/v1/lab/oru/ingest': {
    summary: 'Ingest an authenticated HL7 ORU result message',
    description: 'Uses the immutable migration-582 sender/message-control replay claim. Optional I01 recovery requires an owner-authorized high-water marker and creates result plus no-SLA human-review evidence without retrospective SLA/pathway/notification effects. Local orders are table-explicit: VHINV-<id> resolves only investigations and requires exact structured analyte identity. No VHBOOK producer is currently supported.',
    request: 'LabOruIngestRequest',
  },
  'POST /api/v1/lab/pathologist/signoff': {
    summary: 'Sign one laboratory result episode',
    description: 'Requires a stable Idempotency-Key, a database-current pathologist-tier actor, one tenant/patient/source episode, and a legal initial or corrective generation state.',
    parameters: [idempotencyKeyParameter],
    request: 'LabPathologistSignoffRequest',
    response: 'LabPathologistSignoffResponse',
  },
};
