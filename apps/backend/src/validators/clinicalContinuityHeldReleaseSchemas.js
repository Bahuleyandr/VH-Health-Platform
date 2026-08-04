import { createHash } from 'node:crypto';

import { AppError } from '../utils/AppError.js';
import { canonicalizeJson } from '../services/downtime/continuityPackCanonical.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const HELD_MESSAGE_FAMILIES = Object.freeze(['I04', 'I05', 'I19']);
export const HELD_MESSAGE_RELEASE_REASONS = Object.freeze([
  'downstream_readiness_confirmed',
  'transport_configuration_corrected',
  'duplicate_delivery_risk_reviewed',
  'acknowledgement_uncertainty_reviewed',
  'owner_recovery_evidence_reconciled',
]);
export const HELD_MESSAGE_RELEASE_SCHEMA = Object.freeze({
  id: 'clinical-continuity-held-message-release',
  version: 1,
  checksum: createHash('sha256').update(canonicalizeJson({
    additionalProperties: false,
    action: 'clinical_continuity.interface_held_message.release',
    families: HELD_MESSAGE_FAMILIES,
    reasons: HELD_MESSAGE_RELEASE_REASONS,
    version: 1,
  })).digest('hex'),
});

function invalid(message, code = 'CONTINUITY_HELD_MESSAGE_COMMAND_INVALID') {
  throw AppError.badRequest(message, code, { safe: true });
}

function exactObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Held-message command must be an object');
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) invalid('Held-message command contains unknown fields');
}

function uuid(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) invalid(`${label} must be a UUID`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) invalid(`${label} must be a positive integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) invalid(`${label} is outside the supported range`);
  return parsed;
}

function fingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) invalid('expected_source_state_fingerprint must be a SHA-256 digest');
  return normalized;
}

function family(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!HELD_MESSAGE_FAMILIES.includes(normalized)) {
    invalid('interface_family must be I04, I05, or I19', 'CONTINUITY_HELD_MESSAGE_FAMILY_NOT_RELEASEABLE');
  }
  return normalized;
}

function releaseFields(value, allowed) {
  exactObject(value, allowed);
  const releaseReasonCode = String(value.release_reason_code || '').trim().toLowerCase();
  if (!HELD_MESSAGE_RELEASE_REASONS.includes(releaseReasonCode)) invalid('release_reason_code is invalid');
  const releaseReasonDetail = String(value.release_reason_detail || '').trim().replace(/\s+/g, ' ');
  const containsControlCharacter = [...releaseReasonDetail]
    .some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
  if (releaseReasonDetail.length < 10 || releaseReasonDetail.length > 500 || containsControlCharacter) {
    invalid('release_reason_detail must contain 10-500 non-control characters');
  }
  return {
    expectedVersion: positiveInteger(value.expected_version, 'expected_version'),
    releaseReasonCode,
    releaseReasonDetail,
    sourceStateFingerprint: fingerprint(value.expected_source_state_fingerprint),
  };
}

export function parseHeldMessageBinding(value) {
  exactObject(value, [
    'incident_interface_id',
    'interface_family',
    'message_id',
    'expected_incident_interface_version',
    'expected_source_state_fingerprint',
  ]);
  return Object.freeze({
    incidentInterfaceId: uuid(value.incident_interface_id, 'incident_interface_id'),
    interfaceFamily: family(value.interface_family),
    messageId: positiveInteger(value.message_id, 'message_id'),
    expectedIncidentInterfaceVersion: positiveInteger(
      value.expected_incident_interface_version,
      'expected_incident_interface_version',
    ),
    sourceStateFingerprint: fingerprint(value.expected_source_state_fingerprint),
  });
}

export function parseHeldMessageAttestation(value) {
  return Object.freeze(releaseFields(value, [
    'expected_version',
    'release_reason_code',
    'release_reason_detail',
    'expected_source_state_fingerprint',
  ]));
}

export function parseHeldMessageRelease(value) {
  return Object.freeze({
    ...releaseFields(value, [
      'expected_version',
      'release_reason_code',
      'release_reason_detail',
      'expected_source_state_fingerprint',
      'safety_attestation_id',
    ]),
    safetyAttestationId: uuid(value.safety_attestation_id, 'safety_attestation_id', { nullable: true }),
  });
}

export const __testing__ = Object.freeze({ HASH_PATTERN, UUID_PATTERN });
