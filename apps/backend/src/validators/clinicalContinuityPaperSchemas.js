import { hashCanonicalValue } from '../services/downtime/continuityPackCanonical.js';
import { AppError } from '../utils/AppError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PAPER_ID_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,127}$/;

const COMMON_FIELDS = Object.freeze([
  'expected_version',
  'occurred_at',
  'original_actor_uid',
  'original_actor_role',
  'patient_uid',
  'encounter_id',
  'evidence_hash',
]);

const DEFINITIONS = Object.freeze({
  'mar.administration.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/mar-administration-backfill',
    version: 1,
    fields: Object.freeze([...COMMON_FIELDS, 'medication_administration_id', 'notes']),
    required: Object.freeze([...COMMON_FIELDS, 'medication_administration_id']),
  }),
  'lab.specimen_collection.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/lab-specimen-collection-backfill',
    version: 1,
    fields: Object.freeze([...COMMON_FIELDS, 'investigation_id', 'specimen_barcode', 'collection_notes']),
    required: Object.freeze([...COMMON_FIELDS, 'investigation_id', 'specimen_barcode']),
  }),
  'blood.transfusion_verification.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/blood-transfusion-verification-backfill',
    version: 1,
    fields: Object.freeze([
      ...COMMON_FIELDS,
      'blood_request_id',
      'blood_unit_id',
      'first_verifier_uid',
      'second_verifier_uid',
      'scanned_unit_number',
      'unit_match',
      'patient_match',
      'group_compatible',
      'expiry_ok',
      'override_reason',
    ]),
    required: Object.freeze([
      ...COMMON_FIELDS,
      'blood_request_id',
      'blood_unit_id',
      'first_verifier_uid',
      'second_verifier_uid',
      'scanned_unit_number',
      'unit_match',
      'patient_match',
      'group_compatible',
      'expiry_ok',
    ]),
  }),
});

export const CLINICAL_CONTINUITY_PAPER_ACTIONS = Object.freeze(
  Object.fromEntries(Object.entries(DEFINITIONS).map(([actionId, definition]) => [
    actionId,
    Object.freeze({
      ...definition,
      checksum: hashCanonicalValue({
        actionId,
        fields: definition.fields,
        id: definition.id,
        required: definition.required,
        version: definition.version,
      }),
    }),
  ])),
);

function invalid(message, code = 'CONTINUITY_PAPER_COMMAND_INVALID') {
  throw AppError.badRequest(message, code, { safe: true });
}

function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(fields);
  return Object.keys(value).every(key => allowed.has(key));
}

function uuid(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) invalid(`${label} must be a UUID`);
  return normalized;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid(`${label} must be a positive integer`);
  return parsed;
}

function text(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) invalid(`${label} is invalid`);
  return normalized;
}

function timestamp(value, label) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) invalid(`${label} must be an ISO timestamp`);
  if (date.getTime() > Date.now() + 5 * 60_000) invalid(`${label} cannot be in the future`);
  return date.toISOString();
}

export function normalizePaperIdentity({ incidentId, paperItemId }) {
  const normalizedPaperId = String(paperItemId || '').trim().toUpperCase();
  if (!PAPER_ID_PATTERN.test(normalizedPaperId)) {
    invalid('paper_item_id is invalid', 'CONTINUITY_PAPER_ITEM_INVALID');
  }
  return Object.freeze({
    incidentId: uuid(incidentId, 'incident_id'),
    paperItemId: normalizedPaperId,
  });
}

export function parseClinicalContinuityPaperCommand({ actionId, body, incidentId, paperItemId }) {
  const definition = CLINICAL_CONTINUITY_PAPER_ACTIONS[actionId];
  if (!definition) {
    invalid('Paper action is not approved', 'CONTINUITY_PAPER_ACTION_DENIED');
  }
  if (!exactObject(body, definition.fields)) invalid('Paper command contains unsupported fields');
  for (const field of definition.required) {
    const present = Object.prototype.hasOwnProperty.call(body, field);
    const missingValue = body[field] === undefined || body[field] === '';
    if (!present || missingValue || (body[field] === null && field !== 'encounter_id')) {
      invalid(`${field} is required`);
    }
  }
  const identity = normalizePaperIdentity({ incidentId, paperItemId });
  const normalized = {
    expected_version: positiveInteger(body.expected_version, 'expected_version'),
    occurred_at: timestamp(body.occurred_at, 'occurred_at'),
    original_actor_uid: uuid(body.original_actor_uid, 'original_actor_uid'),
    original_actor_role: text(body.original_actor_role, 'original_actor_role', 80),
    patient_uid: uuid(body.patient_uid, 'patient_uid'),
    encounter_id: uuid(body.encounter_id, 'encounter_id', { nullable: true }),
    evidence_hash: String(body.evidence_hash || '').trim().toLowerCase(),
  };
  if (!HASH_PATTERN.test(normalized.evidence_hash)) invalid('evidence_hash must be a SHA-256 hex digest');

  if (actionId === 'mar.administration.backfill') {
    Object.assign(normalized, {
      medication_administration_id: positiveInteger(
        body.medication_administration_id,
        'medication_administration_id',
      ),
      notes: text(body.notes, 'notes', 2000, { nullable: true }),
    });
  } else if (actionId === 'lab.specimen_collection.backfill') {
    Object.assign(normalized, {
      investigation_id: positiveInteger(body.investigation_id, 'investigation_id'),
      specimen_barcode: text(body.specimen_barcode, 'specimen_barcode', 100),
      collection_notes: text(body.collection_notes, 'collection_notes', 2000, { nullable: true }),
    });
  } else {
    const firstVerifier = uuid(body.first_verifier_uid, 'first_verifier_uid');
    const secondVerifier = uuid(body.second_verifier_uid, 'second_verifier_uid');
    if (firstVerifier === secondVerifier) {
      invalid('Transfusion verifiers must be distinct', 'CONTINUITY_TRANSFUSION_VERIFIER_SEPARATION_REQUIRED');
    }
    for (const field of ['unit_match', 'patient_match', 'group_compatible', 'expiry_ok']) {
      if (typeof body[field] !== 'boolean') invalid(`${field} must be boolean`);
    }
    Object.assign(normalized, {
      blood_request_id: positiveInteger(body.blood_request_id, 'blood_request_id'),
      blood_unit_id: positiveInteger(body.blood_unit_id, 'blood_unit_id'),
      first_verifier_uid: firstVerifier,
      second_verifier_uid: secondVerifier,
      scanned_unit_number: text(body.scanned_unit_number, 'scanned_unit_number', 60),
      unit_match: body.unit_match,
      patient_match: body.patient_match,
      group_compatible: body.group_compatible,
      expiry_ok: body.expiry_ok,
      override_reason: text(body.override_reason, 'override_reason', 2000, { nullable: true }),
    });
  }

  return Object.freeze({
    actionId,
    definition,
    identity,
    normalized: Object.freeze(normalized),
  });
}

export const __testing__ = Object.freeze({ DEFINITIONS, HASH_PATTERN, PAPER_ID_PATTERN, UUID_PATTERN });
