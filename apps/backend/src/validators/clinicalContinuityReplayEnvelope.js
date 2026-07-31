import {
  canonicalizeJson,
  hashCanonicalValue
} from '../services/downtime/continuityPackCanonical.js';
import { AppError } from '../utils/AppError.js';

export const CLINICAL_CONTINUITY_REPLAY_ENVELOPE_HEADER = 'x-vh-continuity-command-envelope';
export const CLINICAL_CONTINUITY_REPLAY_SOURCE_HEADER = 'x-vh-continuity-receipt-source';
export const ELECTRONIC_REPLAY_SOURCE = 'electronic_queue';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}(?:\d{3})?)?Z$/;
const ENVELOPE_KEYS = Object.freeze([
  'action_checksum',
  'action_id',
  'action_schema_checksum',
  'action_schema_id',
  'action_schema_version',
  'action_version',
  'admission_id',
  'app_version',
  'appointment_id',
  'base_etag',
  'base_revision',
  'cached_sources',
  'capture_actor_uuid',
  'capture_role',
  'capture_session_id',
  'captured_at',
  'client_event_id',
  'clock_evidence',
  'command_fingerprint',
  'device_id',
  'device_posture',
  'encounter_id',
  'envelope_schema_version',
  'expires_at',
  'facility_id',
  'human_review_required',
  'idempotency_key',
  'incident_id',
  'minimum_app_version',
  'occurred_at',
  'ordering_key',
  'ordering_key_digest',
  'patient_reference',
  'payload_hash',
  'policy_checksum',
  'policy_effective_from',
  'policy_effective_until',
  'policy_id',
  'policy_revocation_epoch',
  'policy_signing_key_id',
  'policy_supersedes_id',
  'policy_version',
  'predecessor_client_event_id',
  'queue_schema_version',
  'queued_at',
  'registry_checksum',
  'registry_version',
  'sequence',
  'source_cache_version',
  'supersession_generation',
  'tenant_id',
  'unit_id'
]);
const CLOCK_KEYS = Object.freeze([
  'midpoint',
  'observed_at',
  'route_kind',
  'server_time',
  'skew_milliseconds',
  'tolerance_milliseconds',
  'uncertainty_milliseconds'
]);

function replayConflict(code) {
  return AppError.conflict('Clinical continuity replay requires manual review', code, {
    decision: 'needs_review',
    safe: true
  });
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validString(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function validNullableString(value) {
  return value === null || validString(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validNullableUuid(value) {
  return value === null || validUuid(value);
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validNullableDecimal(value, { allowZero = false } = {}) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return allowZero || value !== '0';
}

function decodeCanonicalEnvelope(value) {
  try {
    const encoded = String(value || '').trim();
    if (!encoded || encoded.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw replayConflict('CONTINUITY_REPLAY_ENVELOPE_REQUIRED');
    }
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (Buffer.from(canonicalizeJson(parsed), 'utf8').toString('base64url') !== encoded) {
      throw replayConflict('CONTINUITY_REPLAY_ENVELOPE_NON_CANONICAL');
    }
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw replayConflict('CONTINUITY_REPLAY_ENVELOPE_INVALID');
  }
}

function validateClockEvidence(value) {
  if (!hasExactKeys(value, CLOCK_KEYS)) return false;
  return (
    validTimestamp(value.midpoint) &&
    validTimestamp(value.observed_at) &&
    validTimestamp(value.server_time) &&
    validString(value.route_kind) &&
    Number.isSafeInteger(value.skew_milliseconds) &&
    validNonNegativeInteger(value.tolerance_milliseconds) &&
    validNonNegativeInteger(value.uncertainty_milliseconds) &&
    value.uncertainty_milliseconds <= value.tolerance_milliseconds
  );
}

function validateCachedSources(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, timestamp]) => validString(key) && validTimestamp(timestamp))
  );
}

function validateEnvelopeShape(envelope) {
  if (!hasExactKeys(envelope, ENVELOPE_KEYS)) return false;
  const requiredStrings = [
    'action_id',
    'action_schema_id',
    'app_version',
    'capture_role',
    'device_posture',
    'idempotency_key',
    'minimum_app_version',
    'ordering_key',
    'policy_revocation_epoch',
    'policy_signing_key_id',
    'policy_version',
    'registry_version'
  ];
  const hashes = [
    'action_checksum',
    'action_schema_checksum',
    'command_fingerprint',
    'ordering_key_digest',
    'payload_hash',
    'policy_checksum',
    'registry_checksum'
  ];
  const timestamps = [
    'captured_at',
    'expires_at',
    'occurred_at',
    'policy_effective_from',
    'policy_effective_until',
    'queued_at'
  ];
  return (
    requiredStrings.every(key => validString(envelope[key])) &&
    hashes.every(key => HASH_PATTERN.test(envelope[key])) &&
    timestamps.every(key => validTimestamp(envelope[key])) &&
    [
      'capture_actor_uuid',
      'capture_session_id',
      'client_event_id',
      'device_id',
      'patient_reference',
      'policy_id',
      'tenant_id'
    ].every(key => validUuid(envelope[key])) &&
    ['incident_id', 'encounter_id', 'policy_supersedes_id', 'predecessor_client_event_id'].every(
      key => validNullableUuid(envelope[key])
    ) &&
    validNullableDecimal(envelope.admission_id) &&
    validNullableDecimal(envelope.appointment_id) &&
    validNullableDecimal(envelope.base_revision, { allowZero: true }) &&
    ['base_etag', 'source_cache_version', 'unit_id'].every(key =>
      validNullableString(envelope[key])
    ) &&
    validPositiveInteger(envelope.facility_id) &&
    validPositiveInteger(envelope.envelope_schema_version) &&
    validPositiveInteger(envelope.queue_schema_version) &&
    validPositiveInteger(envelope.action_version) &&
    validPositiveInteger(envelope.action_schema_version) &&
    validPositiveInteger(envelope.sequence) &&
    validNonNegativeInteger(envelope.supersession_generation) &&
    typeof envelope.human_review_required === 'boolean' &&
    validateClockEvidence(envelope.clock_evidence) &&
    validateCachedSources(envelope.cached_sources)
  );
}

export function clientFingerprintProjection(envelope) {
  const projection = { ...envelope };
  delete projection.client_event_id;
  delete projection.idempotency_key;
  delete projection.command_fingerprint;
  delete projection.queued_at;
  return projection;
}

export function receiptFingerprintProjection({ envelope, binding, payloadHash }) {
  return {
    action_id: envelope.action_id,
    binding_id: binding.bindingId,
    client_command_fingerprint: envelope.command_fingerprint,
    http_method: binding.method,
    payload_hash: payloadHash,
    schema_checksum: binding.schemaRecord.checksum,
    schema_id: binding.schemaRecord.id,
    schema_version: binding.schemaRecord.version
  };
}

export function parseClinicalContinuityReplayEnvelope({
  encodedEnvelope,
  sourceKind,
  body,
  idempotencyKey,
  binding,
  authorization,
  tenantId,
  replayActorUid
}) {
  if (sourceKind !== ELECTRONIC_REPLAY_SOURCE) {
    throw replayConflict('CONTINUITY_REPLAY_SOURCE_UNSUPPORTED');
  }
  const envelope = decodeCanonicalEnvelope(encodedEnvelope);
  if (!validateEnvelopeShape(envelope) || envelope.base_revision === null) {
    throw replayConflict('CONTINUITY_REPLAY_ENVELOPE_INVALID');
  }
  const payloadHash = hashCanonicalValue(body);
  const clientFingerprint = hashCanonicalValue(clientFingerprintProjection(envelope));
  const facilityContext = authorization?.facilityContext;
  const claims = authorization?.authorityClaims;
  const authorizedContext = authorization?.requestContext;
  const appointmentId = body.appointment_id == null ? null : String(body.appointment_id);
  const cachedSourcesHeader = Object.entries(envelope.cached_sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, timestamp]) => `${sourceId}=${timestamp}`)
    .join(',');
  if (
    payloadHash !== envelope.payload_hash ||
    clientFingerprint !== envelope.command_fingerprint ||
    idempotencyKey !== envelope.idempotency_key ||
    envelope.action_id !== binding.actionId ||
    envelope.action_schema_id !== binding.schemaRecord.id ||
    envelope.action_schema_version !== binding.schemaRecord.version ||
    envelope.action_schema_checksum !== binding.schemaRecord.checksum ||
    envelope.tenant_id !== tenantId ||
    envelope.facility_id !== facilityContext?.facilityId ||
    envelope.device_id !== facilityContext?.deviceId ||
    envelope.capture_session_id !== authorization?.captureSessionId ||
    envelope.captured_at !== authorization?.capturedAt ||
    envelope.app_version !== authorization?.clientAppVersion ||
    cachedSourcesHeader !== authorization?.cachedSourcesHeader ||
    envelope.capture_actor_uuid !== replayActorUid ||
    envelope.capture_role !== authorizedContext?.actorRole ||
    envelope.device_posture !== authorizedContext?.devicePosture ||
    envelope.patient_reference !== body.patient_uid ||
    envelope.appointment_id !== appointmentId ||
    envelope.encounter_id !== null ||
    envelope.admission_id !== null ||
    envelope.action_version !== claims?.actionVersion ||
    envelope.action_checksum !== claims?.actionChecksum ||
    envelope.policy_id !== claims?.policyId ||
    envelope.policy_version !== claims?.policyVersion ||
    envelope.policy_checksum !== claims?.policyChecksum ||
    envelope.policy_signing_key_id !== claims?.policySigningKeyId ||
    envelope.policy_effective_from !== claims?.policyEffectiveFrom ||
    envelope.policy_effective_until !== claims?.policyEffectiveUntil ||
    envelope.policy_supersedes_id !== claims?.policySupersedesId ||
    envelope.policy_revocation_epoch !== claims?.revocationEpoch ||
    envelope.registry_version !== claims?.registryVersion ||
    envelope.registry_checksum !== claims?.registryChecksum
  ) {
    throw replayConflict('CONTINUITY_REPLAY_ENVELOPE_IDENTITY_MISMATCH');
  }
  const occurredAt = Date.parse(envelope.occurred_at);
  const capturedAt = Date.parse(envelope.captured_at);
  const queuedAt = Date.parse(envelope.queued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  const policyEffectiveFrom = Date.parse(envelope.policy_effective_from);
  const policyEffectiveUntil = Date.parse(envelope.policy_effective_until);
  const clockObservedAt = Date.parse(envelope.clock_evidence.observed_at);
  const clockMidpoint = Date.parse(envelope.clock_evidence.midpoint);
  const clockServerTime = Date.parse(envelope.clock_evidence.server_time);
  const measuredSkew = clockServerTime - clockMidpoint;
  const cachedSourceAfterCapture = Object.values(envelope.cached_sources).some(
    timestamp => Date.parse(timestamp) > capturedAt
  );
  if (
    occurredAt > capturedAt ||
    capturedAt > queuedAt ||
    queuedAt > expiresAt ||
    expiresAt > capturedAt + 7 * 24 * 60 * 60 * 1_000 ||
    expiresAt <= Date.now() ||
    policyEffectiveFrom > capturedAt ||
    policyEffectiveUntil <= capturedAt ||
    expiresAt > policyEffectiveUntil ||
    !['public', 'internal'].includes(envelope.clock_evidence.route_kind) ||
    clockObservedAt > capturedAt ||
    measuredSkew !== envelope.clock_evidence.skew_milliseconds ||
    Math.abs(measuredSkew) + envelope.clock_evidence.uncertainty_milliseconds >
      envelope.clock_evidence.tolerance_milliseconds ||
    cachedSourceAfterCapture ||
    envelope.human_review_required
  ) {
    throw replayConflict('CONTINUITY_REPLAY_TIME_OR_REVIEW_CONFLICT');
  }
  const receiptFingerprint = hashCanonicalValue(
    receiptFingerprintProjection({ envelope, binding, payloadHash })
  );
  return Object.freeze({
    envelope,
    payloadHash,
    receiptFingerprint,
    sourceKind
  });
}

export const __testing__ = Object.freeze({
  clockKeys: CLOCK_KEYS,
  envelopeKeys: ENVELOPE_KEYS,
  validateEnvelopeShape
});
