import Ajv from 'ajv';
import { canonicalizeJson, hashCanonicalValue } from '../services/downtime/continuityPackCanonical.js';

function frozenSchema(value) {
  return Object.freeze(JSON.parse(canonicalizeJson(value)));
}

const patientUid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
};

const content = {
  type: 'object',
  maxProperties: 256,
  additionalProperties: true
};

export const NURSING_NOTE_DRAFT_ACTION_SCHEMA = frozenSchema({
  $id: 'vhhealth://clinical-continuity/actions/emr.nursing_note.draft.store/v1',
  type: 'object',
  additionalProperties: false,
  required: ['content', 'note_type', 'patient_uid'],
  properties: {
    content,
    note_type: { const: 'nursing_assessment' },
    patient_uid: patientUid
  },
  'x-continuity-discriminator': {
    field: 'note_type',
    values: ['nursing_assessment']
  }
});

export const OP_NOTE_DRAFT_ACTION_SCHEMA = frozenSchema({
  $id: 'vhhealth://clinical-continuity/actions/emr.op_note.draft.store/v1',
  type: 'object',
  additionalProperties: false,
  required: ['content', 'note_type', 'patient_uid'],
  properties: {
    appointment_id: {
      type: 'integer',
      minimum: 1,
      maximum: 2_147_483_647
    },
    content,
    note_type: { const: 'op_consultation' },
    patient_uid: patientUid
  },
  'x-continuity-discriminator': {
    field: 'note_type',
    values: ['op_consultation']
  }
});

export const CLINICAL_CONTINUITY_ACTION_SCHEMAS = Object.freeze({
  'emr.nursing_note.draft.store/v1': Object.freeze({
    id: 'emr.nursing_note.draft.store/v1',
    version: 1,
    checksum: hashCanonicalValue(NURSING_NOTE_DRAFT_ACTION_SCHEMA),
    schema: NURSING_NOTE_DRAFT_ACTION_SCHEMA
  }),
  'emr.op_note.draft.store/v1': Object.freeze({
    id: 'emr.op_note.draft.store/v1',
    version: 1,
    checksum: hashCanonicalValue(OP_NOTE_DRAFT_ACTION_SCHEMA),
    schema: OP_NOTE_DRAFT_ACTION_SCHEMA
  })
});

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  validateSchema: true
});
ajv.addKeyword({
  keyword: 'x-continuity-discriminator',
  schemaType: 'object'
});

const validators = new Map(
  Object.values(CLINICAL_CONTINUITY_ACTION_SCHEMAS).map(record => [
    record.id,
    ajv.compile(record.schema)
  ])
);

export function validateClinicalContinuityActionBody(schemaId, body) {
  const validator = validators.get(schemaId);
  if (!validator) {
    return {
      ok: false,
      errors: [{ keyword: 'schema', message: `Unknown action schema ${schemaId}` }]
    };
  }
  const ok = validator(body);
  return {
    ok,
    errors: ok
      ? []
      : validator.errors.map(error => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message
        }))
  };
}
