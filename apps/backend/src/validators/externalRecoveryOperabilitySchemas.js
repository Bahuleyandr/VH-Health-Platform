import { createHash } from 'node:crypto';

import { EXTERNAL_INTERFACE_RECOVERY_FAMILIES } from '../config/externalInterfaceRecoveryCatalog.js';
import { AppError } from '../utils/AppError.js';
import { canonicalizeJson } from '../services/downtime/continuityPackCanonical.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export const EXTERNAL_RECOVERY_REGISTER_REASONS = Object.freeze([
  'initial_marker_reconciled',
  'retained_range_verified',
  'marker_absence_recorded'
]);
export const EXTERNAL_RECOVERY_RESUME_REASONS = Object.freeze([
  'resume_cutoff_reconciled',
  'source_count_reconciled',
  'owner_recovery_evidence_reconciled'
]);
export const EXTERNAL_RECOVERY_OPERABILITY_SCHEMA = Object.freeze({
  id: 'external-recovery-operability',
  version: 1,
  checksum: createHash('sha256')
    .update(
      canonicalizeJson({
        additionalProperties: false,
        actions: ['register_offset', 'authorize_resume'],
        registerReasons: EXTERNAL_RECOVERY_REGISTER_REASONS,
        resumeReasons: EXTERNAL_RECOVERY_RESUME_REASONS,
        version: 1
      })
    )
    .digest('hex')
});

function invalid(message, code = 'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID') {
  throw AppError.badRequest(message, code, { safe: true });
}

function exactObject(value, allowed, label = 'External-recovery command') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    invalid(`${label} contains unknown fields`);
  }
}

function text(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) invalid(`${label} is invalid`);
  return normalized;
}

function positiveInteger(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) invalid(`${label} must be a positive integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) invalid(`${label} is outside the supported range`);
  return parsed;
}

function position(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  let parsed;
  try {
    parsed = BigInt(String(value));
  } catch {
    invalid(`${label} must be a non-negative BIGINT`);
  }
  if (parsed < 0n || parsed > MAX_BIGINT) invalid(`${label} must be a non-negative BIGINT`);
  return parsed.toString();
}

function marker(value, prefix, { nullable = false } = {}) {
  const markerPosition = position(value[`${prefix}_position`], `${prefix}_position`, { nullable });
  const markerToken = text(value[`${prefix}_token`], `${prefix}_token`, 255, { nullable });
  if ((markerPosition === null) !== (markerToken === null)) {
    invalid(`${prefix}_position and ${prefix}_token must be supplied together`);
  }
  return { position: markerPosition, token: markerToken };
}

function family(value) {
  const normalized = text(value, 'interface_family', 3).toUpperCase();
  if (!EXTERNAL_INTERFACE_RECOVERY_FAMILIES.includes(normalized)) {
    invalid('interface_family must be exactly I01 through I30');
  }
  return normalized;
}

function fingerprint(value) {
  const normalized = text(value, 'expected_state_fingerprint', 64).toLowerCase();
  if (!HASH_PATTERN.test(normalized))
    invalid('expected_state_fingerprint must be a SHA-256 digest');
  return normalized;
}

function timestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) invalid(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function reason(value, allowed) {
  const code = text(value.reason_code, 'reason_code', 80).toLowerCase();
  if (!allowed.includes(code)) invalid('reason_code is invalid');
  const rawDetail = String(value.reason_detail || '').trim();
  const hasControl = [...rawDetail].some(
    character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127
  );
  const detail = rawDetail.replace(/\s+/g, ' ');
  if (detail.length < 10 || detail.length > 500 || hasControl) {
    invalid('reason_detail must contain 10-500 non-control characters');
  }
  return { code, detail };
}

function ownerEvidence(value) {
  return Object.freeze({
    reference: text(value.owner_evidence_reference, 'owner_evidence_reference', 255),
    signature: text(value.owner_evidence_signature, 'owner_evidence_signature', 512)
  });
}

export function parseExternalRecoveryRegister(value) {
  exactObject(value, [
    'interface_family',
    'subpath',
    'protocol',
    'stream_direction',
    'source_partition',
    'generation',
    'facility_id',
    'initial_position',
    'initial_token',
    'retained_from_position',
    'retained_from_token',
    'policy_version',
    'policy_signature',
    'retention_policy',
    'retention_until',
    'owner_evidence_reference',
    'owner_evidence_signature',
    'reason_code',
    'reason_detail'
  ]);
  const initial = marker(value, 'initial', { nullable: true });
  const retained = marker(value, 'retained_from', { nullable: true });
  const parsedReason = reason(value, EXTERNAL_RECOVERY_REGISTER_REASONS);
  if (initial.position === null && parsedReason.code !== 'marker_absence_recorded') {
    invalid('An absent marker requires marker_absence_recorded');
  }
  if (initial.position !== null && parsedReason.code === 'marker_absence_recorded') {
    invalid('marker_absence_recorded requires an absent marker');
  }
  return Object.freeze({
    interfaceFamily: family(value.interface_family),
    subpath: text(value.subpath, 'subpath', 80, { nullable: true })?.toLowerCase() ?? null,
    protocol: text(value.protocol, 'protocol', 40, { nullable: true })?.toLowerCase() ?? null,
    streamDirection:
      text(value.stream_direction, 'stream_direction', 20, { nullable: true })?.toLowerCase() ??
      null,
    sourcePartition: text(value.source_partition, 'source_partition', 160),
    generation: positiveInteger(value.generation, 'generation'),
    facilityId: positiveInteger(value.facility_id, 'facility_id', { nullable: true }),
    initialPosition: initial.position,
    initialToken: initial.token,
    retainedFromPosition: retained.position,
    retainedFromToken: retained.token,
    policyVersion: text(value.policy_version, 'policy_version', 80),
    policySignature: text(value.policy_signature, 'policy_signature', 128),
    retentionPolicy: text(value.retention_policy, 'retention_policy', 80),
    retentionUntil: timestamp(value.retention_until, 'retention_until'),
    ownerEvidence: ownerEvidence(value),
    reasonCode: parsedReason.code,
    reasonDetail: parsedReason.detail
  });
}

export function parseExternalRecoveryResume(value) {
  exactObject(value, [
    'expected_state_fingerprint',
    'resume_cutoff_position',
    'resume_cutoff_token',
    'owner_evidence_reference',
    'owner_evidence_signature',
    'reason_code',
    'reason_detail'
  ]);
  const cutoff = marker(value, 'resume_cutoff');
  const parsedReason = reason(value, EXTERNAL_RECOVERY_RESUME_REASONS);
  return Object.freeze({
    expectedStateFingerprint: fingerprint(value.expected_state_fingerprint),
    resumeCutoffPosition: cutoff.position,
    resumeCutoffToken: cutoff.token,
    ownerEvidence: ownerEvidence(value),
    reasonCode: parsedReason.code,
    reasonDetail: parsedReason.detail
  });
}

export function parseExternalRecoveryWorkbenchQuery(value = {}) {
  exactObject(value, ['interface_family', 'recovery_state'], 'External-recovery workbench query');
  return Object.freeze({
    interfaceFamily:
      value.interface_family == null || value.interface_family === ''
        ? null
        : family(value.interface_family),
    recoveryState:
      text(value.recovery_state, 'recovery_state', 80, { nullable: true })?.toLowerCase() ?? null
  });
}

export const __testing__ = Object.freeze({ HASH_PATTERN });
