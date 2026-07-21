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
};
