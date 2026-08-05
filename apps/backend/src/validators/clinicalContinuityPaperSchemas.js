import { hashCanonicalValue } from '../services/downtime/continuityPackCanonical.js';
import { CLINICAL_CONTINUITY_ACTIONS_BY_ID } from '../config/clinicalContinuityActionCatalog.js';
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

const PAPER_ACTION_IDS = Object.freeze([
  'mar.administration.backfill',
  'lab.specimen_collection.backfill',
  'blood.transfusion_verification.backfill',
]);

const CATALOGUE_CONTRACTS = Object.freeze({
  'mar.administration.backfill': Object.freeze({
    actionChecksum: '26884e408883b51609058a037fe08e90d23223a04244f41a03eb3e3824a281b4',
    actionVersion: 1,
    breakGlass: 'override_bearing_action_blocked_electronic',
    clinicalObjectClass: 'physical_action',
    conflictOwner: 'medication_safety_and_nursing_governance',
    domain: 'medication_administration',
    identityBindings: Object.freeze({
      actor: Object.freeze(['original_actor_uid', 'original_actor_role']),
      tenant: Object.freeze(['$server.tenant_id']),
      facility: Object.freeze(['$server.facility_id']),
      patient: Object.freeze(['patient_uid']),
      admission: Object.freeze(['admission_id']),
      mar_administration: Object.freeze(['medication_administration_id']),
      paper_item: Object.freeze(['$path.paper_item_id']),
      incident: Object.freeze(['$path.incident_id']),
    }),
    quarantineOwner: 'medication_safety_and_nursing_governance',
    replayDisposition: 'generic_mar_replay_denied',
    witness: 'owner_defined_checker_required',
  }),
  'lab.specimen_collection.backfill': Object.freeze({
    actionChecksum: 'bff9b2795da8a16c5db2d7a6be10c38282ec4e773388d0aef7a5e0e2cfea3c69',
    actionVersion: 1,
    breakGlass: 'blocked',
    clinicalObjectClass: 'physical_action',
    conflictOwner: 'laboratory_and_phlebotomy_governance',
    domain: 'laboratory_specimen',
    identityBindings: Object.freeze({
      actor: Object.freeze(['original_actor_uid', 'original_actor_role']),
      tenant: Object.freeze(['$server.tenant_id']),
      facility: Object.freeze(['$server.facility_id']),
      patient: Object.freeze(['patient_uid']),
      investigation: Object.freeze(['investigation_id']),
      specimen: Object.freeze(['specimen_barcode']),
      paper_item: Object.freeze(['$path.paper_item_id']),
      incident: Object.freeze(['$path.incident_id']),
    }),
    quarantineOwner: 'laboratory_and_phlebotomy_governance',
    replayDisposition: 'generic_specimen_replay_denied',
    witness: 'owner_defined_checker_required',
  }),
  'blood.transfusion_verification.backfill': Object.freeze({
    actionChecksum: '68e11f7812438bd3afc59531ef912664a4dc52dcfb76a99aa9dbdb9f723fc70d',
    actionVersion: 1,
    breakGlass: 'blocked',
    clinicalObjectClass: 'physical_action',
    conflictOwner: 'blood_bank_and_transfusion_safety_governance',
    domain: 'blood_bank',
    identityBindings: Object.freeze({
      actor: Object.freeze(['original_actor_uid', 'original_actor_role']),
      tenant: Object.freeze(['$server.tenant_id']),
      facility: Object.freeze(['$server.facility_id']),
      patient: Object.freeze(['patient_uid']),
      encounter: Object.freeze(['encounter_id']),
      blood_request: Object.freeze(['blood_request_id']),
      blood_unit: Object.freeze(['blood_unit_id']),
      paper_item: Object.freeze(['$path.paper_item_id']),
      incident: Object.freeze(['$path.incident_id']),
    }),
    quarantineOwner: 'blood_bank_and_transfusion_safety_governance',
    replayDisposition: 'generic_transfusion_replay_denied',
    witness: 'two_distinct_currently_authorized_verifiers',
  }),
});

const DEFINITIONS = Object.freeze({
  'mar.administration.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/mar-administration-backfill',
    version: 2,
    catalogueContract: CATALOGUE_CONTRACTS['mar.administration.backfill'],
    fields: Object.freeze([
      ...COMMON_FIELDS,
      'admission_id',
      'medication_administration_id',
      'checker_uid',
      'checker_role',
      'notes',
    ]),
    required: Object.freeze([
      ...COMMON_FIELDS,
      'admission_id',
      'medication_administration_id',
      'checker_uid',
      'checker_role',
    ]),
  }),
  'lab.specimen_collection.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/lab-specimen-collection-backfill',
    version: 2,
    catalogueContract: CATALOGUE_CONTRACTS['lab.specimen_collection.backfill'],
    fields: Object.freeze([
      ...COMMON_FIELDS,
      'investigation_id',
      'specimen_barcode',
      'checker_uid',
      'checker_role',
      'collection_notes',
    ]),
    required: Object.freeze([
      ...COMMON_FIELDS,
      'investigation_id',
      'specimen_barcode',
      'checker_uid',
      'checker_role',
    ]),
  }),
  'blood.transfusion_verification.backfill': Object.freeze({
    id: 'vhhealth/continuity/paper/blood-transfusion-verification-backfill',
    version: 2,
    catalogueContract: CATALOGUE_CONTRACTS['blood.transfusion_verification.backfill'],
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
        catalogueContract: definition.catalogueContract,
        fields: definition.fields,
        id: definition.id,
        required: definition.required,
        version: definition.version,
      }),
    }),
  ])),
);

function parityFailure(actionId, message) {
  throw new Error(`Clinical continuity paper/catalogue drift for ${actionId}: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertClinicalContinuityPaperCatalogParity({
  catalogue = CLINICAL_CONTINUITY_ACTIONS_BY_ID,
  paperActions = CLINICAL_CONTINUITY_PAPER_ACTIONS,
} = {}) {
  const paperIds = Object.keys(paperActions).sort();
  if (!sameValue(paperIds, [...PAPER_ACTION_IDS].sort())) {
    parityFailure('paper-action-map', 'the closed three-action set changed');
  }

  for (const actionId of PAPER_ACTION_IDS) {
    const paper = paperActions[actionId];
    const expected = paper?.catalogueContract;
    const action = catalogue[actionId];
    if (!paper || !expected || !action) parityFailure(actionId, 'entry is missing');

    const { actionChecksum, ...canonicalContract } = action;
    if (hashCanonicalValue(canonicalContract) !== actionChecksum) {
      parityFailure(actionId, 'catalogue checksum is not canonical');
    }
    if (actionChecksum !== expected.actionChecksum) parityFailure(actionId, 'action checksum changed');
    if (action.actionVersion !== expected.actionVersion) parityFailure(actionId, 'action version changed');
    if (action.approvalEvidence?.decisionId !== 'C-D3') parityFailure(actionId, 'C-D3 approval is missing');
    if (action.classification?.captureReady !== false) parityFailure(actionId, 'captureReady must remain false');
    if (action.classification?.offlineClass !== 'paper_only_backfill') parityFailure(actionId, 'offline class changed');
    if (action.classification?.clinicalObjectClass !== expected.clinicalObjectClass) {
      parityFailure(actionId, 'clinical object class changed');
    }
    if (action.scope?.domain !== expected.domain || action.scope?.facilityScoped !== true) {
      parityFailure(actionId, 'scope changed');
    }
    if (action.actionSchema?.id !== 'none' || action.actionSchema?.version !== 0 || action.actionSchema?.checksum !== null) {
      parityFailure(actionId, 'electronic action schema became executable');
    }
    if (action.replayEndpoint?.bindingId !== 'none') parityFailure(actionId, 'electronic replay binding appeared');
    if (action.replayEndpoint?.disposition !== expected.replayDisposition) parityFailure(actionId, 'replay disposition changed');
    if (action.witness !== expected.witness) parityFailure(actionId, 'witness contract changed');
    if (action.breakGlass !== expected.breakGlass) parityFailure(actionId, 'break-glass posture changed');
    if (
      action.conflictOwnership?.owner !== expected.conflictOwner
      || action.conflictOwnership?.outcome !== 'needs_review'
    ) parityFailure(actionId, 'conflict owner changed');
    if (
      action.quarantineOwnership?.owner !== expected.quarantineOwner
      || action.quarantineOwnership?.durableState !== 'needs_review'
    ) parityFailure(actionId, 'quarantine owner changed');

    const identityKeys = Object.keys(expected.identityBindings);
    if (!sameValue(action.requiredIdentity, identityKeys)) parityFailure(actionId, 'required identity set changed');
    for (const fields of Object.values(expected.identityBindings)) {
      for (const field of fields) {
        if (field.startsWith('$')) continue;
        if (!paper.fields.includes(field) || !paper.required.includes(field)) {
          parityFailure(actionId, `required identity field ${field} is not mandatory in the paper schema`);
        }
      }
    }

    if (expected.witness === 'owner_defined_checker_required') {
      for (const field of ['checker_uid', 'checker_role']) {
        if (!paper.fields.includes(field) || !paper.required.includes(field)) {
          parityFailure(actionId, `${field} is required by the checker contract`);
        }
      }
    } else {
      for (const field of ['first_verifier_uid', 'second_verifier_uid']) {
        if (!paper.fields.includes(field) || !paper.required.includes(field)) {
          parityFailure(actionId, `${field} is required by the two-verifier contract`);
        }
      }
    }
    if (paper.fields.includes('override_reason')) parityFailure(actionId, 'blocked override field is exposed');
  }
  return true;
}

assertClinicalContinuityPaperCatalogParity();

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
    const checkerUid = uuid(body.checker_uid, 'checker_uid');
    if (checkerUid === normalized.original_actor_uid) {
      invalid('MAR checker must be distinct from the original actor', 'CONTINUITY_PAPER_CHECKER_SEPARATION_REQUIRED');
    }
    Object.assign(normalized, {
      admission_id: positiveInteger(body.admission_id, 'admission_id'),
      medication_administration_id: positiveInteger(
        body.medication_administration_id,
        'medication_administration_id',
      ),
      checker_uid: checkerUid,
      checker_role: text(body.checker_role, 'checker_role', 80).toUpperCase(),
      notes: text(body.notes, 'notes', 2000, { nullable: true }),
    });
  } else if (actionId === 'lab.specimen_collection.backfill') {
    const checkerUid = uuid(body.checker_uid, 'checker_uid');
    if (checkerUid === normalized.original_actor_uid) {
      invalid('Specimen checker must be distinct from the original actor', 'CONTINUITY_PAPER_CHECKER_SEPARATION_REQUIRED');
    }
    Object.assign(normalized, {
      investigation_id: positiveInteger(body.investigation_id, 'investigation_id'),
      specimen_barcode: text(body.specimen_barcode, 'specimen_barcode', 100),
      checker_uid: checkerUid,
      checker_role: text(body.checker_role, 'checker_role', 80).toUpperCase(),
      collection_notes: text(body.collection_notes, 'collection_notes', 2000, { nullable: true }),
    });
  } else {
    if (!normalized.encounter_id) {
      invalid('encounter_id is required for transfusion verification', 'CONTINUITY_TRANSFUSION_ENCOUNTER_REQUIRED');
    }
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
    });
  }

  return Object.freeze({
    actionId,
    definition,
    identity,
    normalized: Object.freeze(normalized),
  });
}

export const __testing__ = Object.freeze({
  CATALOGUE_CONTRACTS,
  DEFINITIONS,
  HASH_PATTERN,
  PAPER_ACTION_IDS,
  PAPER_ID_PATTERN,
  UUID_PATTERN,
});
