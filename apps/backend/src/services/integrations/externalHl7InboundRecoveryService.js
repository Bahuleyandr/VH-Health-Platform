import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  decryptField,
  encryptField,
  getKeyId,
  isEncrypted,
} from '../../utils/fieldEncryption.js';
import { generateACK, parseHL7 } from '../hl7/hl7Parser.js';
import {
  loadTenantKekIntoProvider,
} from '../security/tenantKekProvider.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';
import {
  canonicalCommandFingerprint,
  enqueueExternalRecoveryItem,
  processNextItemTx,
  quarantineI03RecoveryEvidenceConflictTx,
} from './externalInterfaceRecoveryService.js';

export const I03_RECOVERY_SCHEMA = 'vhhealth.i03.adt-orm-sequence/v1';
export const I03_MAX_MESSAGE_BYTES = 2_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;
const NON_NEGATIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_INTEGER = 2_147_483_647;
const TOP_LEVEL_KEYS = new Set(['message', 'recovery']);
const RECOVERY_KEYS = new Set([
  'schema',
  'interface_family',
  'arrival_class',
  'tenant_id',
  'signing_credential_id',
  'offset_id',
  'source_partition',
  'generation',
  'source_position',
  'source_token',
  'predecessor_token',
  'duplicate_key',
  'message_family',
  'message_type',
  'trigger_event',
  'message_control_id',
  'message_sha256',
  'source_observed_at',
  'source_received_at',
  'clock_evidence',
]);

async function requireI03TenantKek(tenantId) {
  try {
    // The tenant's CURRENT key id — a shredded-then-re-provisioned tenant is on a
    // later version, so this must never be assumed to be v1.
    const { keyId } = await loadTenantKekIntoProvider(tenantId);
    return keyId;
  } catch {
    throw AppError.internal(
      'I03 recovery tenant encryption key is unavailable',
      'HL7_I03_RECOVERY_TENANT_KEK_REQUIRED',
    );
  }
}

const CLOCK_KEYS = new Set([
  'source_clock_id',
  'synchronized_at',
  'maximum_error_ms',
]);
const MESSAGE_IDENTITIES = Object.freeze({
  'ADT^A01': Object.freeze({ family: 'adt', type: 'ADT', trigger: 'A01' }),
  'ADT^A02': Object.freeze({ family: 'adt', type: 'ADT', trigger: 'A02' }),
  'ADT^A03': Object.freeze({ family: 'adt', type: 'ADT', trigger: 'A03' }),
  'ORM^O01': Object.freeze({ family: 'orm', type: 'ORM', trigger: 'O01' }),
});
const OUTCOMES = Object.freeze({
  adt: 'i03_adt_pending_admission_reconciliation',
  orm: 'i03_orm_pending_order_reconciliation',
});
const REVIEW_ROLES = Object.freeze({
  adt: 'MEDICAL_RECORDS',
  orm: 'DUTY_DOCTOR',
});

function refuse(message, code = 'HL7_I03_RECOVERY_CONTRACT_INVALID') {
  throw AppError.badRequest(message, code);
}

function conflict(message, code = 'HL7_I03_RECOVERY_REFUSED') {
  throw AppError.conflict(message, code);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireClosedRecord(value, keys, label) {
  if (!isPlainRecord(value)) refuse(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some(key => !keys.has(key))) {
    refuse(`${label} fields do not match the registered schema`);
  }
  return value;
}

function requireString(value, label, max, { trimmed = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    refuse(`${label} is invalid`);
  }
  if (trimmed && value.trim() !== value) refuse(`${label} is invalid`);
  return value;
}

function requireExact(value, expected, label) {
  if (value !== expected) refuse(`${label} is invalid`);
  return expected;
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    refuse(`${label} must be a lowercase UUID`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    refuse(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function requireCredentialId(value) {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_RE.test(value)) {
    refuse('signing_credential_id must be a canonical positive decimal');
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_INTEGER)) refuse('signing_credential_id is out of range');
  return value;
}

function requireGeneration(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INTEGER) {
    refuse('generation must be a positive integer');
  }
  return value;
}

function requirePosition(value) {
  if (typeof value !== 'string' || !NON_NEGATIVE_DECIMAL_RE.test(value)) {
    refuse('source_position must be a canonical non-negative decimal');
  }
  if (BigInt(value) > MAX_BIGINT) refuse('source_position is out of range');
  return value;
}

function timestampFromParts({
  year,
  month,
  day,
  hour,
  minute,
  second,
  fraction = '',
  offsetSign = '+',
  offsetHour = '00',
  offsetMinute = '00',
}, label) {
  const numbers = [year, month, day, hour, minute, second, offsetHour, offsetMinute]
    .map(value => Number(value));
  const [y, mo, d, h, mi, s, oh, om] = numbers;
  if (y < 1) refuse(`${label} is invalid`);
  if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) refuse(`${label} is invalid`);
  if (offsetSign === '-' && oh === 0 && om === 0) {
    refuse(`${label} has an unknown or ambiguous UTC offset`);
  }
  if (String(fraction).length > 6) refuse(`${label} exceeds database timestamp precision`);
  const fractionMicrosText = String(fraction).padEnd(6, '0');
  const fractionMicros = BigInt(fractionMicrosText || '0');
  const signedOffsetMinutes = (offsetSign === '-' ? -1 : 1) * ((oh * 60) + om);
  const local = new Date(0);
  local.setUTCFullYear(y, mo - 1, d);
  local.setUTCHours(h, mi, s, 0);
  if (
    local.getUTCFullYear() !== y
    || local.getUTCMonth() !== mo - 1
    || local.getUTCDate() !== d
    || local.getUTCHours() !== h
    || local.getUTCMinutes() !== mi
    || local.getUTCSeconds() !== s
  ) {
    refuse(`${label} is invalid`);
  }
  const utc = local.getTime() - (signedOffsetMinutes * 60_000);
  const utcSecond = new Date(utc).toISOString().slice(0, 19);
  if (!/^\d{4}-/.test(utcSecond)) refuse(`${label} is out of range`);
  const precision = Math.max(3, String(fraction).length);
  return Object.freeze({
    iso: `${utcSecond}.${fractionMicrosText.slice(0, precision)}Z`,
    epochMicros: (BigInt(utc) * 1000n) + fractionMicros,
  });
}

function parseExplicitOffsetTimestampValue(value, label = 'timestamp') {
  if (typeof value !== 'string') refuse(`${label} must include an explicit UTC offset`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) refuse(`${label} must include seconds and an explicit UTC offset`);
  return timestampFromParts({
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4],
    minute: match[5],
    second: match[6],
    fraction: match[7] || '',
    offsetSign: match[8] === 'Z' ? '+' : match[9],
    offsetHour: match[8] === 'Z' ? '00' : match[10],
    offsetMinute: match[8] === 'Z' ? '00' : match[11],
  }, label);
}

export function parseExplicitOffsetTimestamp(value, label = 'timestamp') {
  return parseExplicitOffsetTimestampValue(value, label).iso;
}

function parseI03Hl7OccurrenceValue(value, label = 'source occurrence') {
  if (typeof value !== 'string') refuse(`${label} must include an explicit UTC offset`);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) refuse(`${label} must include seconds and an explicit UTC offset`);
  return timestampFromParts({
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4],
    minute: match[5],
    second: match[6],
    fraction: match[7] || '',
    offsetSign: match[8],
    offsetHour: match[9],
    offsetMinute: match[10],
  }, label);
}

export function parseI03Hl7Occurrence(value, label = 'source occurrence') {
  return parseI03Hl7OccurrenceValue(value, label).iso;
}

function i03TimestampsEqual(left, right) {
  return parseExplicitOffsetTimestampValue(left).epochMicros
    === parseExplicitOffsetTimestampValue(right).epochMicros;
}

export function validateI03ClockEvidence(
  clockEvidence,
  { sourceObservedAt, sourceReceivedAt } = {},
) {
  const clock = requireClosedRecord(clockEvidence, CLOCK_KEYS, 'clock_evidence');
  const sourceClockId = requireString(clock.source_clock_id, 'source_clock_id', 120);
  if (!isWellFormedUnicode(sourceClockId)) {
    refuse(
      'clock_evidence.source_clock_id contains malformed Unicode',
      'HL7_I03_RECOVERY_CLOCK_ENCODING_INVALID',
    );
  }
  if ([...sourceClockId].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  })) {
    refuse('clock_evidence.source_clock_id is invalid');
  }
  const synchronized = parseExplicitOffsetTimestampValue(
    clock.synchronized_at,
    'clock_evidence.synchronized_at',
  );
  if (
    typeof clock.maximum_error_ms !== 'number'
    || !Number.isInteger(clock.maximum_error_ms)
    || clock.maximum_error_ms < 0
    || clock.maximum_error_ms > 300_000
  ) {
    refuse('clock_evidence.maximum_error_ms is invalid');
  }
  const observed = parseExplicitOffsetTimestampValue(sourceObservedAt, 'source_observed_at');
  const received = parseExplicitOffsetTimestampValue(sourceReceivedAt, 'source_received_at');
  if (synchronized.epochMicros > received.epochMicros) {
    refuse('clock synchronization cannot post-date sender receipt');
  }
  if (
    received.epochMicros + (BigInt(clock.maximum_error_ms) * 1000n)
    < observed.epochMicros
  ) {
    refuse('sender receipt precedes the clinical occurrence beyond declared clock error');
  }
  return Object.freeze({
    sourceClockId,
    synchronizedAt: synchronized.iso,
    maximumErrorMs: clock.maximum_error_ms,
    sourceObservedAt: observed.iso,
    sourceReceivedAt: received.iso,
  });
}

export function sha256Utf8(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

export function isWellFormedUnicode(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function requireWellFormedMessage(message) {
  if (!isWellFormedUnicode(message)) {
    refuse('message contains malformed Unicode', 'HL7_I03_RECOVERY_MESSAGE_ENCODING_INVALID');
  }
}

export function lengthPrefixedSha256(components) {
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(String(component), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function i03DuplicateKey({
  tenantId,
  signingCredentialId,
  messageFamily,
  messageType,
  triggerEvent,
  messageControlId,
}) {
  return lengthPrefixedSha256([
    'vh-i03-duplicate-v1',
    tenantId,
    signingCredentialId,
    messageFamily,
    messageType,
    triggerEvent,
    messageControlId,
  ]);
}

export function i03SourceToken({
  tenantId,
  sourcePartition,
  generation,
  sourcePosition,
  predecessorToken,
  duplicateKey,
  messageSha256,
}) {
  return lengthPrefixedSha256([
    'vh-i03-source-token-v1',
    tenantId,
    sourcePartition,
    generation,
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256,
  ]);
}

function segmentCount(parsed, type) {
  if (Number.isInteger(parsed?.segmentCounts?.[type])) return parsed.segmentCounts[type];
  return parsed?.segments?.filter(segment => segment.type === type).length || 0;
}

function requireUnambiguousSegments(parsed, identity) {
  if (segmentCount(parsed, 'MSH') !== 1) refuse('Recovery message requires exactly one MSH segment');
  if (segmentCount(parsed, 'PID') !== 1) refuse('Recovery message requires exactly one PID segment');
  if (identity.family === 'adt') {
    if (segmentCount(parsed, 'EVN') !== 1 || segmentCount(parsed, 'ORC') !== 0) {
      refuse('ADT recovery requires exactly one EVN segment and no ORC segment');
    }
  } else if (segmentCount(parsed, 'ORC') !== 1 || segmentCount(parsed, 'EVN') !== 0) {
    refuse('ORM recovery requires exactly one ORC segment and no EVN segment');
  }
}

function identityEvidence(parsed, identity) {
  const msh = parsed.segments.find(segment => segment.type === 'MSH')?.fields || [];
  const pv1 = parsed.segments.filter(segment => segment.type === 'PV1').map(segment => segment.fields);
  const orc = parsed.segments.find(segment => segment.type === 'ORC')?.fields || [];
  const obr = parsed.segments.filter(segment => segment.type === 'OBR').map(segment => segment.fields);
  if (identity.family === 'adt') {
    const values = [msh[6] || '', msh[12] || ''];
    for (const fields of pv1) values.push(fields[19] || '', fields[44] || '', fields[45] || '');
    return Object.freeze({
      visitIdentitySha256: values.some(Boolean)
        ? lengthPrefixedSha256(['vh-i03-visit-identity-v1', ...values])
        : null,
      orderIdentitySha256: null,
    });
  }
  const values = [msh[6] || '', msh[12] || '', orc[2] || ''];
  for (const fields of obr) values.push(fields[2] || '', fields[4] || '');
  return Object.freeze({
    visitIdentitySha256: null,
    orderIdentitySha256: values.some(Boolean)
      ? lengthPrefixedSha256(['vh-i03-order-identity-v1', ...values])
      : null,
  });
}

export function buildI03RecoverySignedPayload({ message, recovery } = {}) {
  if (typeof message !== 'string') refuse('message must be a string');
  requireWellFormedMessage(message);
  requireClosedRecord(recovery, RECOVERY_KEYS, 'recovery');
  const messageSha256 = sha256Utf8(message);
  const recoverySha256 = canonicalCommandFingerprint(recovery);
  return Object.freeze({
    messageSha256,
    recoverySha256,
    signedPayload: `${I03_RECOVERY_SCHEMA}\n${messageSha256}\n${recoverySha256}`,
  });
}

export function prepareHl7InboundRecoveryAuthentication({ body, parsed = null } = {}) {
  const request = requireClosedRecord(body, TOP_LEVEL_KEYS, 'recovery request');
  const message = requireString(request.message, 'message', I03_MAX_MESSAGE_BYTES, { trimmed: false });
  requireWellFormedMessage(message);
  const payloadBytes = Buffer.byteLength(message, 'utf8');
  if (payloadBytes > I03_MAX_MESSAGE_BYTES) refuse('message exceeds the I03 recovery byte limit');
  const recovery = requireClosedRecord(request.recovery, RECOVERY_KEYS, 'recovery');
  const clockEvidence = requireClosedRecord(recovery.clock_evidence, CLOCK_KEYS, 'clock_evidence');

  let parsedMessage = parsed;
  if (!parsedMessage) {
    try {
      parsedMessage = parseHL7(message);
    } catch {
      refuse('message is not valid HL7v2', 'HL7_I03_RECOVERY_HL7_INVALID');
    }
  }
  if (!parsedMessage?.msh) refuse('Recovery message requires an MSH segment');
  const identity = MESSAGE_IDENTITIES[parsedMessage.msh.messageType];
  if (!identity) refuse('Recovery message type is not supported');
  requireUnambiguousSegments(parsedMessage, identity);

  requireExact(recovery.schema, I03_RECOVERY_SCHEMA, 'schema');
  requireExact(recovery.interface_family, 'I03', 'interface_family');
  requireExact(recovery.arrival_class, 'recovery_backlog', 'arrival_class');
  const tenantId = requireUuid(recovery.tenant_id, 'tenant_id');
  const signingCredentialId = requireCredentialId(recovery.signing_credential_id);
  const offsetId = requireUuid(recovery.offset_id, 'offset_id');
  const generation = requireGeneration(recovery.generation);
  const sourcePosition = requirePosition(recovery.source_position);
  const sourceToken = requireSha256(recovery.source_token, 'source_token');
  const predecessorToken = requireSha256(recovery.predecessor_token, 'predecessor_token');
  const duplicateKey = requireSha256(recovery.duplicate_key, 'duplicate_key');
  requireExact(recovery.message_family, identity.family, 'message_family');
  requireExact(recovery.message_type, identity.type, 'message_type');
  requireExact(recovery.trigger_event, identity.trigger, 'trigger_event');
  const controlId = requireString(
    recovery.message_control_id,
    'message_control_id',
    199,
    { trimmed: false },
  );
  if (controlId !== parsedMessage.msh.messageControlId) {
    refuse('message_control_id does not match MSH-10');
  }

  const signed = buildI03RecoverySignedPayload({ message, recovery });
  const messageSha256 = requireSha256(recovery.message_sha256, 'message_sha256');
  if (messageSha256 !== signed.messageSha256) refuse('message_sha256 does not match exact message bytes');
  const sourcePartition = requireString(recovery.source_partition, 'source_partition', 160);
  const expectedPartition = `i03/credential/${signingCredentialId}/family/${identity.family}`;
  if (sourcePartition !== expectedPartition) refuse('source_partition is not canonical');

  const expectedDuplicate = i03DuplicateKey({
    tenantId,
    signingCredentialId,
    messageFamily: identity.family,
    messageType: identity.type,
    triggerEvent: identity.trigger,
    messageControlId: controlId,
  });
  if (duplicateKey !== expectedDuplicate) refuse('duplicate_key does not match the I03 identity');
  const expectedSourceToken = i03SourceToken({
    tenantId,
    sourcePartition,
    generation,
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256,
  });
  if (sourceToken !== expectedSourceToken) refuse('source_token does not match the I03 source evidence');

  const occurrenceField = identity.family === 'adt'
    ? parsedMessage.evn?.recordedDateTime
    : parsedMessage.orc?.transactionDateTime;
  const messageOccurrence = parseI03Hl7Occurrence(
    occurrenceField,
    identity.family === 'adt' ? 'EVN-2 source occurrence' : 'ORC-9 source occurrence',
  );
  const clock = validateI03ClockEvidence(clockEvidence, {
    sourceObservedAt: recovery.source_observed_at,
    sourceReceivedAt: recovery.source_received_at,
  });
  if (!i03TimestampsEqual(messageOccurrence, clock.sourceObservedAt)) {
    refuse('source_observed_at does not match the HL7 source occurrence');
  }

  const patientUid = String(parsedMessage.pid?.patientId || '').toLowerCase();
  if (!UUID_RE.test(patientUid)) refuse('PID-3 must be a UUID-shaped patient identity');
  const evidence = identityEvidence(parsedMessage, identity);
  const closedRecovery = Object.freeze({
    ...recovery,
    clock_evidence: Object.freeze({ ...clockEvidence }),
  });
  const command = Object.freeze({ message, recovery: closedRecovery });
  return Object.freeze({
    message,
    recovery: closedRecovery,
    command,
    parsed: parsedMessage,
    payloadBytes,
    messageSha256,
    recoverySha256: signed.recoverySha256,
    signedPayload: signed.signedPayload,
    tenantId,
    signingCredentialId,
    offsetId,
    sourcePartition,
    generation,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    messageFamily: identity.family,
    messageType: identity.type,
    triggerEvent: identity.trigger,
    messageControlId: controlId,
    sourceObservedAt: clock.sourceObservedAt,
    sourceReceivedAt: clock.sourceReceivedAt,
    clock,
    patientUid,
    ...evidence,
  });
}

function assertCredentialBinding(prepared, credentialSnapshot) {
  if (
    !credentialSnapshot
    || credentialSnapshot.kind !== 'hl7_inbound'
    || credentialSnapshot.status !== 'active'
    || String(credentialSnapshot.id) !== prepared.signingCredentialId
    || String(credentialSnapshot.tenant_id).toLowerCase() !== prepared.tenantId
    || credentialSnapshot.sender_identifier !== prepared.parsed.msh.receivingFacility
  ) {
    throw AppError.forbidden(
      'HL7 recovery credentials do not match the signed recovery envelope',
      'HL7_I03_RECOVERY_CREDENTIAL_MISMATCH',
    );
  }
}

async function assertCanonicalOffsetBinding(prepared) {
  return setTenantTx(prepared.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT offset_id::text, facility_scope, facility_id, interface_family,
              direction, source_partition, consumer_key, cursor_kind, generation,
              high_water_position::text,
              high_water_token, recovery_state, policy_version, policy_signature,
              retention_policy, retention_until
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid
          AND offset_id = $2::uuid
          AND scope_kind = 'external_interface'
          AND interface_family = 'I03'
          AND intake_retired_at IS NULL
        LIMIT 1`,
      prepared.tenantId,
      prepared.offsetId,
    );
    const offset = rows[0];
    if (!offset) {
      conflict(
        'Canonical I03 recovery offset is missing',
        'HL7_I03_RECOVERY_MARKER_MISSING',
      );
    }
    if (
      offset.facility_scope !== 'tenant'
      || offset.facility_id !== null
      || offset.interface_family !== 'I03'
      || offset.direction !== 'inbound'
      || offset.consumer_key !== 'external:I03'
      || offset.cursor_kind !== 'monotonic_position_and_predecessor'
      || offset.source_partition !== prepared.sourcePartition
      || Number(offset.generation) !== prepared.generation
    ) {
      conflict(
        'Recovery envelope does not match its canonical offset',
        'HL7_I03_RECOVERY_OFFSET_MISMATCH',
      );
    }
    if (offset.high_water_position === null || offset.high_water_token === null) {
      conflict(
        'Canonical I03 recovery marker is missing',
        'HL7_I03_RECOVERY_MARKER_MISSING',
      );
    }
    return Object.freeze({ ...offset });
  }, { isolationLevel: 'Serializable' });
}

export async function assertHl7InboundLivePathAvailable({
  tenantId,
  signingCredentialId,
  messageFamily,
} = {}) {
  const tid = requireTenantId(tenantId);
  const credentialId = requireCredentialId(String(signingCredentialId));
  if (!['adt', 'orm'].includes(messageFamily)) refuse('message_family is invalid');
  const sourcePartition = `i03/credential/${credentialId}/family/${messageFamily}`;
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT offset_id::text, generation, recovery_state
         FROM event_consumer_offsets
        WHERE tenant_id = $1::uuid
          AND scope_kind = 'external_interface'
          AND interface_family = 'I03'
          AND direction = 'inbound'
          AND source_partition = $2::text
          AND intake_retired_at IS NULL
          AND recovery_state <> 'ready'
        LIMIT 1`,
      tid,
      sourcePartition,
    );
    if (rows.length > 0) {
      conflict(
        'This enrolled I03 stream requires the signed recovery envelope',
        'HL7_I03_RECOVERY_ENVELOPE_REQUIRED',
      );
    }
    return true;
  });
}

export async function assertEnvBackedHl7InboundLivePathAvailable({
  receivingFacility,
  messageFamily,
} = {}) {
  const senderIdentifier = String(receivingFacility || '').trim();
  if (!senderIdentifier) refuse('receiving_facility is invalid');
  if (!['adt', 'orm'].includes(messageFamily)) refuse('message_family is invalid');
  let credentials;
  try {
    credentials = await prisma.$queryRawUnsafe(
      `SELECT id::text, tenant_id::text
         FROM tenant_interop_secrets
        WHERE kind = 'hl7_inbound'
          AND sender_identifier = $1::text`,
      senderIdentifier,
    );
  } catch {
    throw AppError.internal(
      'I03 recovery enrollment lookup is unavailable',
      'HL7_I03_RECOVERY_ENROLLMENT_LOOKUP_FAILED',
    );
  }
  if (credentials.length === 0) return true;
  if (credentials.length !== 1) {
    throw AppError.internal(
      'I03 recovery enrollment lookup is unavailable',
      'HL7_I03_RECOVERY_ENROLLMENT_LOOKUP_FAILED',
    );
  }
  const credential = credentials[0];
  const sourcePartition = `i03/credential/${credential.id}/family/${messageFamily}`;
  let enrolled;
  try {
    enrolled = await setTenantTx(credential.tenant_id, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT offset_id::text
           FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid
            AND scope_kind = 'external_interface'
            AND interface_family = 'I03'
            AND direction = 'inbound'
            AND source_partition = $2::text
            AND intake_retired_at IS NULL
            AND recovery_state <> 'ready'
          LIMIT 1`,
        credential.tenant_id,
        sourcePartition,
      );
      return rows.length > 0;
    });
  } catch {
    throw AppError.internal(
      'I03 recovery enrollment lookup is unavailable',
      'HL7_I03_RECOVERY_ENROLLMENT_LOOKUP_FAILED',
    );
  }
  if (enrolled) {
    conflict(
      'This enrolled I03 stream requires the signed recovery envelope',
      'HL7_I03_RECOVERY_ENVELOPE_REQUIRED',
    );
  }
  return true;
}

export async function enqueueHl7InboundRecovery({
  message,
  recovery,
  parsed = null,
  credentialSnapshot,
  leaseOwner = null,
} = {}) {
  const prepared = prepareHl7InboundRecoveryAuthentication({
    body: { message, recovery },
    parsed,
  });
  assertCredentialBinding(prepared, credentialSnapshot);
  await assertCanonicalOffsetBinding(prepared);
  const enqueueResult = await enqueueExternalRecoveryItem({
    tenantId: prepared.tenantId,
    offsetId: prepared.offsetId,
    interfaceFamily: 'I03',
    sourcePartition: prepared.sourcePartition,
    generation: prepared.generation,
    sourcePosition: prepared.sourcePosition,
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    occurredAt: prepared.sourceObservedAt,
    command: prepared.command,
    commandFingerprint: prepared.messageSha256,
    arrivalClass: 'recovery_backlog',
    leaseOwner,
  });
  return Object.freeze({ prepared, enqueueResult });
}

async function resolveSameTenantPatient(tx, tenantId, patientUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.uid::text
       FROM users AS u
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
        AND u.role = 'PATIENT'
        AND u.is_active = true
        AND u.status = 'active'
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM patient_merge_requests AS merge
           WHERE merge.tenant_id = u.tenant_id
             AND merge.secondary_uid = u.uid
             AND merge.status = 'executed'
        )
      FOR KEY SHARE OF u`,
    tenantId,
    patientUid,
  );
  return rows[0]?.uid || null;
}

function assertAdapterBinding({
  prepared,
  tenantId,
  recoveryInboxId,
  sourcePartition,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  occurredAt,
  offset,
}) {
  if (
    prepared.tenantId !== tenantId
    || prepared.offsetId !== offset?.offset_id
    || prepared.sourcePartition !== sourcePartition
    || prepared.sourcePartition !== offset?.source_partition
    || prepared.generation !== Number(offset?.generation)
    || prepared.sourcePosition !== String(sourcePosition)
    || prepared.sourceToken !== sourceToken
    || prepared.predecessorToken !== predecessorToken
    || prepared.duplicateKey !== duplicateKey
    || !i03TimestampsEqual(prepared.sourceObservedAt, String(occurredAt))
    || offset?.interface_family !== 'I03'
    || offset?.direction !== 'inbound'
    || offset?.facility_scope !== 'tenant'
    || offset?.facility_id !== null
    || !recoveryInboxId
  ) {
    conflict(
      'I03 adapter command does not match the locked canonical item',
      'HL7_I03_RECOVERY_COMMAND_MISMATCH',
    );
  }
  if (
    !offset.policy_version
    || !offset.policy_signature
    || !offset.retention_policy
    || !offset.retention_until
  ) {
    conflict('I03 recovery policy evidence is incomplete', 'HL7_I03_RECOVERY_POLICY_MISSING');
  }
}

export async function persistLateHl7InboundRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  sourcePartition,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  occurredAt,
  offset,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'I03 recovery requires the canonical recovery transaction',
      'HL7_I03_RECOVERY_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(String(recoveryInboxId), 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I03',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) {
    conflict('I03 recovery capability does not match the canonical inbox');
  }

  const prepared = prepareHl7InboundRecoveryAuthentication({ body: command });
  assertAdapterBinding({
    prepared,
    tenantId: tid,
    recoveryInboxId: inboxId,
    sourcePartition,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    occurredAt,
    offset,
  });
  const credentials = await tx.$queryRawUnsafe(
    `SELECT id::text
       FROM tenant_interop_secrets
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
        AND kind = 'hl7_inbound'
        AND sender_identifier = $3::text
        AND status = 'active'
      FOR KEY SHARE`,
    tid,
    prepared.signingCredentialId,
    prepared.parsed.msh.receivingFacility,
  );
  if (credentials.length !== 1) {
    conflict(
      'I03 signing credential is stale or invalid',
      'HL7_I03_RECOVERY_CREDENTIAL_MISMATCH',
    );
  }

  const expectedTenantKeyId = await requireI03TenantKek(tid);

  const patientUid = await resolveSameTenantPatient(tx, tid, prepared.patientUid);
  const ids = await tx.$queryRawUnsafe(
    `SELECT nextval('public.hl7_inbound_recovery_receipts_id_seq')::text AS id`,
  );
  const receiptId = ids[0]?.id;
  if (!receiptId) {
    throw AppError.internal(
      'I03 recovery receipt identity was not reserved',
      'HL7_I03_RECOVERY_RECEIPT_ID_REQUIRED',
    );
  }

  const reviewRole = REVIEW_ROLES[prepared.messageFamily];
  const outcomeCode = OUTCOMES[prepared.messageFamily];
  const ack = generateACK(
    prepared.messageControlId,
    'AA',
    'Accepted for reconciliation; no live clinical effect',
  );
  const ackSha256 = sha256Utf8(ack);
  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: prepared.messageFamily === 'adt'
      ? 'Review late inbound ADT evidence'
      : 'Review late inbound ORM evidence',
    description: prepared.messageFamily === 'adt'
      ? 'Retained external ADT evidence requires admission reconciliation. No admission effect was applied.'
      : 'Retained external ORM evidence requires order reconciliation. No order effect was applied.',
    patientUid,
    relatedResourceType: 'hl7_inbound_recovery_receipt',
    relatedResourceId: String(receiptId),
    priority: 'high',
    assignedToRole: reviewRole,
    createdBy: null,
    dueAt: null,
    workflowSlaInstanceId: null,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I03',
      recovery_inbox_id: inboxId,
      owner_reconciliation_required: true,
      message_family: prepared.messageFamily,
    },
  });
  if (!task?.id) {
    throw AppError.internal(
      'I03 recovery did not create pending review work',
      'HL7_I03_RECOVERY_TASK_REQUIRED',
    );
  }

  const payloadCiphertext = encryptField(prepared.message, { tenantId: tid });
  const ackCiphertext = encryptField(ack, { tenantId: tid });
  if (
    !String(payloadCiphertext).startsWith('enc:v2:')
    || !String(ackCiphertext).startsWith('enc:v2:')
    || !isEncrypted(payloadCiphertext)
    || !isEncrypted(ackCiphertext)
    || getKeyId(payloadCiphertext) !== expectedTenantKeyId
    || getKeyId(ackCiphertext) !== expectedTenantKeyId
  ) {
    throw AppError.internal(
      'I03 recovery tenant encryption evidence is unavailable',
      'HL7_I03_RECOVERY_TENANT_KEK_REQUIRED',
    );
  }
  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO hl7_inbound_recovery_receipts
       (id, tenant_id, recovery_inbox_id, interface_family,
        signing_credential_id, source_partition, generation, source_position,
        source_token, predecessor_token, duplicate_key, message_family,
        message_type, trigger_event, message_control_id_sha256,
        payload_ciphertext, payload_sha256, payload_bytes,
        source_observed_at, source_received_at, clock_evidence, patient_uid,
        visit_identity_sha256, order_identity_sha256, pending_task_id,
        review_role, status, outcome_code, ack_ciphertext, ack_sha256,
        ack_bytes, ack_code, http_status, policy_version, policy_signature,
        retention_policy, retention_until)
     VALUES
       ($1::bigint, $2::uuid, $3::uuid, 'I03',
        $4::integer, $5::text, $6::integer, $7::bigint,
        $8::char(64), $9::char(64), $10::char(64), $11::text,
        $12::text, $13::text, $14::char(64),
        $15::text, $16::char(64), $17::integer,
        $18::timestamptz, $19::timestamptz, $20::jsonb, $21::uuid,
        $22::char(64), $23::char(64), $24::integer,
        $25::text, 'pending_review', $26::text, $27::text, $28::char(64),
        $29::integer, 'AA', 200, $30::text, $31::text,
        $32::text, $33::timestamptz)
     RETURNING id::text, recovery_inbox_id::text, source_position::text,
               source_token::text, duplicate_key::text, message_family,
               payload_sha256::text, payload_bytes, patient_uid::text,
               pending_task_id, review_role, status, outcome_code,
               ack_sha256::text, ack_bytes, ack_code, http_status, recorded_at`,
    receiptId,
    tid,
    inboxId,
    prepared.signingCredentialId,
    sourcePartition,
    prepared.generation,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    prepared.messageFamily,
    prepared.messageType,
    prepared.triggerEvent,
    sha256Utf8(prepared.messageControlId),
    payloadCiphertext,
    prepared.messageSha256,
    prepared.payloadBytes,
    prepared.sourceObservedAt,
    prepared.sourceReceivedAt,
    JSON.stringify(prepared.recovery.clock_evidence),
    patientUid,
    prepared.visitIdentitySha256,
    prepared.orderIdentitySha256,
    task.id,
    reviewRole,
    outcomeCode,
    ackCiphertext,
    ackSha256,
    Buffer.byteLength(ack, 'utf8'),
    offset.policy_version,
    offset.policy_signature,
    offset.retention_policy,
    offset.retention_until,
  );
  if (receipts.length !== 1) {
    throw AppError.internal(
      'I03 recovery receipt was not committed',
      'HL7_I03_RECOVERY_RECEIPT_REQUIRED',
    );
  }
  return Object.freeze({
    receipt: Object.freeze({ ...receipts[0], id: receipts[0].id }),
    task,
    outcomeCode,
  });
}

function validateStoredAck(row, expected) {
  if (row.inbox_status === 'pending') {
    conflict(
      'The exact I03 recovery item is still pending processing',
      'HL7_I03_RECOVERY_PENDING',
    );
  }
  if (
    row.inbox_status !== 'handled'
    || !row.receipt_id
    || !row.task_id
    || Number(row.inbox_pending_task_id) !== Number(row.receipt_pending_task_id)
    || Number(row.task_id) !== Number(row.receipt_pending_task_id)
    || row.inbox_outcome_code !== row.receipt_outcome_code
    || row.receipt_outcome_code !== OUTCOMES[row.message_family]
    || row.receipt_status !== 'pending_review'
    || row.interface_family !== 'I03'
    || row.review_role !== REVIEW_ROLES[row.message_family]
    || row.inbox_receipt_evidence_matches !== true
    || row.offset_receipt_governance_matches !== true
    || row.ack_code !== 'AA'
    || Number(row.http_status) !== 200
    || row.task_kind !== 'review'
    || row.related_resource_type !== 'hl7_inbound_recovery_receipt'
    || String(row.related_resource_id) !== String(row.receipt_id)
    || row.task_patient_uid !== row.receipt_patient_uid
    || row.sla_completion_semantics !== 'none'
    || row.workflow_sla_instance_id !== null
    || row.due_at !== null
  ) {
    conflict(
      'Stored I03 terminal evidence is incomplete or inconsistent',
      'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
    );
  }
  if (expected && (
    row.source_partition !== expected.sourcePartition
    || Number(row.generation) !== expected.generation
    || String(row.source_position) !== expected.sourcePosition
    || row.source_token !== expected.sourceToken
    || row.predecessor_token !== expected.predecessorToken
    || row.duplicate_key !== expected.duplicateKey
    || row.signing_credential_id !== expected.signingCredentialId
    || row.message_control_id_sha256 !== sha256Utf8(expected.messageControlId)
    || row.payload_sha256 !== expected.messageSha256
    || Number(row.payload_bytes) !== expected.payloadBytes
    || !i03TimestampsEqual(row.source_observed_at, expected.sourceObservedAt)
    || !i03TimestampsEqual(row.source_received_at, expected.sourceReceivedAt)
    || canonicalCommandFingerprint(row.clock_evidence)
      !== canonicalCommandFingerprint(expected.recovery.clock_evidence)
    || (row.receipt_patient_uid !== null && row.receipt_patient_uid !== expected.patientUid)
    || row.visit_identity_sha256 !== expected.visitIdentitySha256
    || row.order_identity_sha256 !== expected.orderIdentitySha256
    || row.message_family !== expected.messageFamily
    || row.message_type !== expected.messageType
    || row.trigger_event !== expected.triggerEvent
  )) {
    conflict(
      'Stored I03 terminal evidence does not match the exact retry',
      'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
    );
  }
}

export async function loadExactHl7InboundRecoveryAck({
  tenantId,
  recoveryInboxId,
  expected = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(String(recoveryInboxId), 'recovery_inbox_id');
  const expectedTenantKeyId = await requireI03TenantKek(tid);
  const result = await setTenantTx(tid, async (tx) => {
    const offsets = await tx.$queryRawUnsafe(
      `SELECT recovery_offset.offset_id::text, recovery_offset.recovery_state,
              recovery_offset.intake_retired_at::text
         FROM pathway_projector_inbox AS inbox
         JOIN event_consumer_offsets AS recovery_offset
           ON recovery_offset.tenant_id = inbox.tenant_id
          AND recovery_offset.offset_id = inbox.offset_id
        WHERE inbox.tenant_id = $1::uuid
          AND inbox.inbox_id = $2::uuid
          AND inbox.scope_kind = 'external_interface'
          AND inbox.interface_family = 'I03'
          AND recovery_offset.scope_kind = 'external_interface'
          AND recovery_offset.interface_family = 'I03'
        LIMIT 1
        FOR UPDATE OF recovery_offset`,
      tid,
      inboxId,
    );
    const offset = offsets[0];
    if (!offset) {
      return Object.freeze({ refusal: 'evidence_conflict' });
    }
    if (offset.recovery_state === 'retired' || offset.intake_retired_at !== null) {
      return Object.freeze({ refusal: 'offset_retired' });
    }
    const commitEvidenceConflict = async () => {
      await quarantineI03RecoveryEvidenceConflictTx({
        tx,
        tenantId: tid,
        offsetId: offset.offset_id,
      });
      return Object.freeze({ refusal: 'evidence_conflict' });
    };
    if (expected && offset.offset_id !== expected.offsetId) {
      return commitEvidenceConflict();
    }
    return (async () => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT inbox.status AS inbox_status,
              inbox.outcome_code AS inbox_outcome_code,
              inbox.pending_task_id AS inbox_pending_task_id,
               receipt.id::text AS receipt_id,
               receipt.interface_family,
               receipt.source_partition, receipt.generation,
               receipt.source_position::text, receipt.source_token::text,
               receipt.predecessor_token::text, receipt.duplicate_key::text,
               receipt.signing_credential_id::text,
               receipt.message_family, receipt.message_type, receipt.trigger_event,
               receipt.message_control_id_sha256::text,
               receipt.payload_ciphertext, receipt.payload_sha256::text,
               receipt.payload_bytes, receipt.pending_task_id AS receipt_pending_task_id,
               to_char(
                 receipt.source_observed_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
               ) AS source_observed_at,
               to_char(
                 receipt.source_received_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
               ) AS source_received_at,
               receipt.clock_evidence,
               receipt.patient_uid::text AS receipt_patient_uid,
               receipt.visit_identity_sha256::text,
               receipt.order_identity_sha256::text,
               receipt.review_role,
               receipt.status AS receipt_status,
              receipt.outcome_code AS receipt_outcome_code,
              receipt.ack_ciphertext, receipt.ack_sha256::text,
               receipt.ack_bytes, receipt.ack_code, receipt.http_status,
               task.id AS task_id, task.task_kind, task.related_resource_type,
               task.related_resource_id, task.sla_completion_semantics,
               task.workflow_sla_instance_id::text, task.due_at,
               task.patient_uid::text AS task_patient_uid,
               (
                 inbox.tenant_id IS NOT DISTINCT FROM receipt.tenant_id
                 AND inbox.interface_family IS NOT DISTINCT FROM receipt.interface_family
                 AND inbox.direction = 'inbound'
                 AND inbox.source_partition IS NOT DISTINCT FROM receipt.source_partition
                 AND inbox.generation IS NOT DISTINCT FROM receipt.generation
                 AND inbox.source_position IS NOT DISTINCT FROM receipt.source_position
                 AND inbox.source_token IS NOT DISTINCT FROM receipt.source_token
                 AND inbox.predecessor_token IS NOT DISTINCT FROM receipt.predecessor_token
                 AND inbox.duplicate_key IS NOT DISTINCT FROM receipt.duplicate_key
                 AND inbox.command_fingerprint IS NOT DISTINCT FROM receipt.payload_sha256
                 AND inbox.occurred_at IS NOT DISTINCT FROM receipt.source_observed_at
                 AND inbox.arrival_class = 'recovery_backlog'
                 AND inbox.effect_disposition = 'late_pending_only'
                 AND inbox.policy_version IS NOT DISTINCT FROM receipt.policy_version
                 AND inbox.policy_signature IS NOT DISTINCT FROM receipt.policy_signature
                 AND inbox.retention_policy IS NOT DISTINCT FROM receipt.retention_policy
                 AND inbox.retention_until IS NOT DISTINCT FROM receipt.retention_until
               ) AS inbox_receipt_evidence_matches,
               (
                 recovery_offset.offset_id IS NOT NULL
                 AND recovery_offset.tenant_id IS NOT DISTINCT FROM receipt.tenant_id
                 AND recovery_offset.scope_kind = 'external_interface'
                 AND recovery_offset.interface_family = 'I03'
                 AND recovery_offset.direction = 'inbound'
                 AND recovery_offset.source_partition IS NOT DISTINCT FROM receipt.source_partition
                 AND recovery_offset.generation IS NOT DISTINCT FROM receipt.generation
                 AND recovery_offset.policy_version IS NOT DISTINCT FROM receipt.policy_version
                 AND recovery_offset.policy_signature IS NOT DISTINCT FROM receipt.policy_signature
                 AND recovery_offset.retention_policy IS NOT DISTINCT FROM receipt.retention_policy
                 AND recovery_offset.retention_until IS NOT DISTINCT FROM receipt.retention_until
               ) AS offset_receipt_governance_matches
         FROM pathway_projector_inbox AS inbox
         LEFT JOIN hl7_inbound_recovery_receipts AS receipt
           ON receipt.tenant_id = inbox.tenant_id
          AND receipt.recovery_inbox_id = inbox.inbox_id
          LEFT JOIN tasks AS task
            ON task.tenant_id = receipt.tenant_id
           AND task.id = receipt.pending_task_id
          LEFT JOIN event_consumer_offsets AS recovery_offset
            ON recovery_offset.tenant_id = inbox.tenant_id
           AND recovery_offset.offset_id = inbox.offset_id
        WHERE inbox.tenant_id = $1::uuid
          AND inbox.inbox_id = $2::uuid
          AND inbox.scope_kind = 'external_interface'
          AND inbox.interface_family = 'I03'
        LIMIT 1`,
      tid,
      inboxId,
    );
    const row = rows[0];
    if (!row) {
      conflict(
        'Stored I03 terminal evidence is unavailable',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    validateStoredAck(row, expected);
    if (
      !String(row.payload_ciphertext).startsWith('enc:v2:')
      || !isEncrypted(row.payload_ciphertext)
      || getKeyId(row.payload_ciphertext) !== expectedTenantKeyId
      || !String(row.ack_ciphertext).startsWith('enc:v2:')
      || !isEncrypted(row.ack_ciphertext)
      || getKeyId(row.ack_ciphertext) !== expectedTenantKeyId
    ) {
      conflict(
        'Stored I03 acknowledgement cannot be verified',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    let payload;
    let ack;
    try {
      payload = decryptField(row.payload_ciphertext);
      ack = decryptField(row.ack_ciphertext);
    } catch {
      conflict(
        'Stored I03 acknowledgement cannot be verified',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    let storedMessage;
    try {
      storedMessage = parseHL7(payload);
    } catch {
      conflict(
        'Stored I03 payload cannot be verified',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    const storedIdentity = MESSAGE_IDENTITIES[storedMessage?.msh?.messageType];
    if (
      typeof payload !== 'string'
      || !isWellFormedUnicode(payload)
      || sha256Utf8(payload) !== row.payload_sha256
      || Buffer.byteLength(payload, 'utf8') !== Number(row.payload_bytes)
      || segmentCount(storedMessage, 'MSH') !== 1
      || !storedIdentity
      || storedIdentity.family !== row.message_family
      || storedIdentity.type !== row.message_type
      || storedIdentity.trigger !== row.trigger_event
      || sha256Utf8(storedMessage.msh.messageControlId) !== row.message_control_id_sha256
      || row.source_partition !== `i03/credential/${row.signing_credential_id}/family/${row.message_family}`
      || (expected && payload !== expected.message)
    ) {
      conflict(
        'Stored I03 payload cannot be verified',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    if (
      typeof ack !== 'string'
      || sha256Utf8(ack) !== row.ack_sha256
      || Buffer.byteLength(ack, 'utf8') !== Number(row.ack_bytes)
    ) {
      conflict(
        'Stored I03 acknowledgement cannot be verified',
        'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
      );
    }
    return Object.freeze({
      ack,
      httpStatus: Number(row.http_status),
      receiptId: row.receipt_id,
      inboxId,
    });
    })().catch(async (error) => {
      if (error?.code !== 'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT') throw error;
      return commitEvidenceConflict();
    });
  });
  if (result.refusal === 'offset_retired') {
    conflict('I03 recovery offset is retired', 'EXTERNAL_RECOVERY_OFFSET_RETIRED');
  }
  if (result.refusal === 'evidence_conflict') {
    conflict(
      'Stored I03 terminal evidence does not match the exact retry',
      'HL7_I03_RECOVERY_EVIDENCE_INCONSISTENT',
    );
  }
  return result;
}

export async function submitHl7InboundRecovery({
  message,
  recovery,
  parsed = null,
  credentialSnapshot,
} = {}) {
  const leaseOwner = randomUUID();
  const queued = await enqueueHl7InboundRecovery({
    message,
    recovery,
    parsed,
    credentialSnapshot,
    leaseOwner,
  });
  const { prepared, enqueueResult } = queued;
  if (enqueueResult.duplicate === true && enqueueResult.status === 'handled') {
    const stored = await loadExactHl7InboundRecoveryAck({
      tenantId: prepared.tenantId,
      recoveryInboxId: enqueueResult.inbox_id,
      expected: prepared,
    });
    return Object.freeze({ ...stored, duplicate: true });
  }
  if (enqueueResult.duplicate === true && enqueueResult.status === 'pending') {
    if (enqueueResult.lease_acquired !== true) {
      conflict(
        'The exact I03 recovery item is still pending processing',
        'HL7_I03_RECOVERY_PENDING',
      );
    }
  }

  const processed = await processNextItemTx({
    tenantId: prepared.tenantId,
    offsetId: prepared.offsetId,
    interfaceFamily: 'I03',
    sourcePartition: prepared.sourcePartition,
    generation: prepared.generation,
    sourcePosition: prepared.sourcePosition,
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    command: prepared.command,
    commandFingerprint: prepared.messageSha256,
    leaseOwner,
  });
  if (processed?.held) {
    conflict(
      'I03 recovery item is held for owner reconciliation',
      'HL7_I03_RECOVERY_SOURCE_HELD',
    );
  }
  const stored = await loadExactHl7InboundRecoveryAck({
    tenantId: prepared.tenantId,
    recoveryInboxId: enqueueResult.inbox_id,
    expected: prepared,
  });
  return Object.freeze({
    ...stored,
    duplicate: enqueueResult.duplicate === true,
  });
}

export default Object.freeze({
  assertEnvBackedHl7InboundLivePathAvailable,
  assertHl7InboundLivePathAvailable,
  buildI03RecoverySignedPayload,
  enqueueHl7InboundRecovery,
  i03DuplicateKey,
  i03SourceToken,
  lengthPrefixedSha256,
  loadExactHl7InboundRecoveryAck,
  parseExplicitOffsetTimestamp,
  parseI03Hl7Occurrence,
  persistLateHl7InboundRecovery,
  prepareHl7InboundRecoveryAuthentication,
  submitHl7InboundRecovery,
  validateI03ClockEvidence,
});
