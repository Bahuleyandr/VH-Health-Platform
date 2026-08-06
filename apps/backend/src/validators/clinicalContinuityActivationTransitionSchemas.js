import { AppError } from '../utils/AppError.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const CLINICAL_CONTINUITY_ADVANCE_REASONS = Object.freeze([
  'enter_shadow',
  'enforcement_evidence_satisfied',
  'staged_enforcement_widening',
]);

export const CLINICAL_CONTINUITY_HALT_REASONS = Object.freeze([
  'clinical_lead_veto',
  'patient_safety_incident',
  'silent_failure',
  'unreconciled_window_breach',
  'listed_signoff_role_halt',
]);

function invalid(message) {
  throw AppError.badRequest(
    message,
    'CLINICAL_CONTINUITY_ACTIVATION_TRANSITION_INPUT_INVALID',
    { safe: true },
  );
}

function exactObject(value, allowed, label = 'Activation transition command') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    invalid(`${label} contains unknown fields`);
  }
}

function uuid(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) invalid(`${label} must be a UUID`);
  return normalized;
}

function fingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    invalid('expected_state_fingerprint must be a SHA-256 digest');
  }
  return normalized;
}

function reason(value, allowed, { detailRequired }) {
  const code = String(value.reason_code || '').trim().toLowerCase();
  if (!allowed.includes(code)) invalid('reason_code is invalid');
  const rawDetail = String(value.reason_detail || '').trim();
  if (!rawDetail && !detailRequired) return Object.freeze({ code, detail: null });
  const hasControl = [...rawDetail].some(
    character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
  );
  const detail = rawDetail.replace(/\s+/g, ' ');
  if (detail.length < 10 || detail.length > 500 || hasControl) {
    invalid('reason_detail must contain 10-500 non-control characters');
  }
  return Object.freeze({ code, detail });
}

function evidenceReferences(value, { minimum = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 20) {
    invalid(`evidence_references must contain ${minimum}-20 exact references`);
  }
  const parsed = value.map((entry, index) => {
    exactObject(entry, ['reference', 'sha256'], `evidence_references[${index}]`);
    const reference = String(entry.reference || '').trim();
    const sha256 = String(entry.sha256 || '').trim().toLowerCase();
    if (!reference || reference.length > 255) {
      invalid(`evidence_references[${index}].reference is invalid`);
    }
    if (!HASH_PATTERN.test(sha256)) {
      invalid(`evidence_references[${index}].sha256 must be a SHA-256 digest`);
    }
    return Object.freeze({ reference, sha256 });
  });
  const keys = parsed.map(entry => `${entry.reference}\u0000${entry.sha256}`);
  if (new Set(keys).size !== keys.length) invalid('evidence_references contains duplicates');
  return Object.freeze(parsed.sort((left, right) => left.reference.localeCompare(right.reference)));
}

export function parseClinicalContinuityAdvanceIntent(value) {
  exactObject(value, [
    'target_policy_id',
    'roster_entry_id',
    'evidence_gate_config_id',
    'expected_state_fingerprint',
    'evidence_references',
    'reason_code',
    'reason_detail',
  ]);
  const parsedReason = reason(value, CLINICAL_CONTINUITY_ADVANCE_REASONS, {
    detailRequired: true,
  });
  return Object.freeze({
    targetPolicyId: uuid(value.target_policy_id, 'target_policy_id'),
    rosterEntryId: uuid(value.roster_entry_id, 'roster_entry_id'),
    evidenceGateConfigId: uuid(value.evidence_gate_config_id, 'evidence_gate_config_id', {
      nullable: true,
    }),
    expectedStateFingerprint: fingerprint(value.expected_state_fingerprint),
    evidenceReferences: evidenceReferences(value.evidence_references),
    reasonCode: parsedReason.code,
    reasonDetail: parsedReason.detail,
  });
}

export function parseClinicalContinuityAdvanceCountersign(value) {
  exactObject(value, [
    'roster_entry_id',
    'expected_state_fingerprint',
    'reason_code',
    'reason_detail',
  ]);
  const parsedReason = reason(value, CLINICAL_CONTINUITY_ADVANCE_REASONS, {
    detailRequired: true,
  });
  return Object.freeze({
    rosterEntryId: uuid(value.roster_entry_id, 'roster_entry_id'),
    expectedStateFingerprint: fingerprint(value.expected_state_fingerprint),
    reasonCode: parsedReason.code,
    reasonDetail: parsedReason.detail,
  });
}

export function parseClinicalContinuityHalt(value) {
  exactObject(value, [
    'roster_entry_id',
    'expected_state_fingerprint',
    'evidence_references',
    'reason_code',
    'reason_detail',
  ]);
  const parsedReason = reason(value, CLINICAL_CONTINUITY_HALT_REASONS, {
    detailRequired: false,
  });
  return Object.freeze({
    rosterEntryId: uuid(value.roster_entry_id, 'roster_entry_id'),
    expectedStateFingerprint: fingerprint(value.expected_state_fingerprint),
    evidenceReferences: evidenceReferences(value.evidence_references || [], { minimum: 0 }),
    reasonCode: parsedReason.code,
    reasonDetail: parsedReason.detail,
  });
}

export const __testing__ = Object.freeze({ HASH_PATTERN, UUID_PATTERN });
