import { envelope } from './_helpers.mjs';

export const schemas = {
  LabAstmIngestRequest: {
    type: 'object',
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
    },
  },
  LabOruIngestRequest: {
    type: 'object',
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        description: 'HL7 ORU^R01 payload. Local investigation references in ORC-2/OBR-2 must use VHINV-<positive PostgreSQL integer>. Bare numeric, malformed VHINV, and reserved VHBOOK identifiers are rejected. A VHINV-linked single-analyte message requires exact investigations.test_code equality with the OBR-4 and every OBX-3 code component. Unrecognized external alphanumeric identifiers remain unlinked shadow data.',
      },
    },
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
    description: 'ASTM-only analyzer inbox. HL7 ORU messages must use /api/v1/lab/oru/ingest so the migration-582 claim remains the single durable replay authority.',
    request: 'LabAstmIngestRequest',
  },
  'POST /api/v1/lab/results': {
    summary: 'Record a manual laboratory result',
    description: 'Requires a stable Idempotency-Key so retries cannot duplicate the result, canonical evidence, or critical-result obligations.',
    parameters: [idempotencyKeyParameter],
  },
  'POST /api/v1/lab/oru/ingest': {
    summary: 'Ingest an authenticated HL7 ORU result message',
    description: 'Uses an immutable sender/message-control replay claim. Local orders are table-explicit: VHINV-<id> resolves only investigations and requires exact structured analyte identity. No VHBOOK producer is currently supported. Bare numeric order IDs fail with LAB_ORU_ORDER_NAMESPACE_REQUIRED before durable writes; external alphanumeric IDs are accepted only as unlinked shadow data and block active-mode cutover.',
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
