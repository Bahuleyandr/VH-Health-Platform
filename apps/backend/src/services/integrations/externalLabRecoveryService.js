import { AppError } from '../../utils/AppError.js';
import { setTenantTx } from '../../lib/prisma.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import {
  assertSupportedOruEnvelope,
  normalizeOruObxRows,
  parseOruOrderIdentity,
  resolveTrustedOruChannel,
} from '../lab/labResultsService.js';
import {
  groundLabInterfaceActor,
  parseAstmMessage,
  resolveTrustedAstmAnalyzer,
  verdictForResult,
} from '../lab/labClosedLoopService.js';
import {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} from '../lab/labCriticalThresholdService.js';
import { createTask } from '../workflow/taskService.js';
import {
  enqueueExternalRecoveryItem,
  processNextItemTx,
} from './externalInterfaceRecoveryService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';
import {
  lengthPrefixedSha256,
  sha256Utf8,
} from './externalVitalsRecoveryService.js';

export const I01_ORU_SEQUENCE_CONTRACT = 'vhhealth.i01.oru-sequence/v1';
export const I02_ASTM_SEQUENCE_CONTRACT = 'vhhealth.i02.astm-sequence/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POSITION_RE = /^(0|[1-9][0-9]*)$/;
const STRICT_NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const COMMON_RECOVERY_KEYS = [
  'schema', 'interface_family', 'arrival_class', 'tenant_id', 'offset_id',
  'source_partition', 'generation', 'source_position', 'source_token',
  'predecessor_token', 'duplicate_key', 'source_observed_at',
  'source_received_at', 'clock_evidence',
];
const I01_RECOVERY_KEYS = new Set([
  ...COMMON_RECOVERY_KEYS,
  'trusted_sender_identity', 'message_control_id', 'message_sha256',
]);
const I02_RECOVERY_KEYS = new Set([
  ...COMMON_RECOVERY_KEYS,
  'analyzer_id', 'analyzer_code', 'analyzer_sender_identity',
  'raw_message_sha256', 'astm_message_sha256',
]);

function refuse(message, code = 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  if (unexpected.length) refuse(`${label} contains unknown fields`, undefined, { unexpected });
  return value;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireText(value, label, max = 255) {
  const text = String(value ?? '');
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
}

function requirePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) refuse(`${label} must be a positive integer`);
  return number;
}

function requirePosition(value, label) {
  const text = String(value ?? '');
  if (!POSITION_RE.test(text)) refuse(`${label} must be a canonical non-negative decimal string`);
  return text;
}

function requireSha(value, label) {
  const text = String(value || '').trim();
  if (!SHA256_RE.test(text)) refuse(`${label} must be lowercase SHA-256`);
  return text;
}

function requireTimestamp(value, label) {
  const text = String(value || '').trim();
  if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(text)) {
    refuse(`${label} must carry an explicit UTC offset`, 'EXTERNAL_RECOVERY_OCCURRENCE_REQUIRED');
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function requireClockEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    refuse('clock_evidence must be a non-empty object');
  }
  return value;
}

function parseHl7Occurrence(raw) {
  const value = String(raw || '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) {
    refuse(
      'OBR-7 source occurrence must include seconds and an explicit UTC offset',
      'EXTERNAL_RECOVERY_OCCURRENCE_REQUIRED',
    );
  }
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  return requireTimestamp(
    `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`,
    'OBR-7 source occurrence',
  );
}

function strictNumericOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text || !STRICT_NUMERIC_RE.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function astmCanonicalMessage(rawMessage) {
  return String(rawMessage || '').trim()
    .split(/\r\n|\r|\n/)
    .map(record => record.trim())
    .filter(Boolean)
    .join('\r');
}

export function i01DuplicateKey({ tenantId, trustedSenderIdentity, messageControlId }) {
  return lengthPrefixedSha256([
    'vh-i01-duplicate-v1',
    String(tenantId).toLowerCase(),
    trustedSenderIdentity,
    messageControlId,
  ]);
}

export function i02DuplicateKey({ tenantId, analyzerId, astmMessageSha256 }) {
  return lengthPrefixedSha256([
    'vh-i02-duplicate-v1',
    String(tenantId).toLowerCase(),
    String(Number(analyzerId)),
    'astm_e1394',
    astmMessageSha256,
  ]);
}

function sourceToken(family, {
  tenantId, sourcePartition, generation, sourcePosition, predecessorToken,
  duplicateKey, payloadSha256,
}) {
  return lengthPrefixedSha256([
    `vh-${family.toLowerCase()}-source-token-v1`,
    String(tenantId).toLowerCase(),
    sourcePartition,
    String(Number(generation)),
    sourcePosition,
    predecessorToken,
    duplicateKey,
    payloadSha256,
  ]);
}

export function i01SourceToken(input) {
  return sourceToken('I01', input);
}

export function i02SourceToken(input) {
  return sourceToken('I02', input);
}

function assertCommonEnvelope(envelope, { tenantId, family, contract }) {
  const authenticatedTenantId = requireUuid(tenantId, 'authenticated tenant_id');
  if (envelope.schema !== contract || envelope.interface_family !== family) {
    refuse(`${family} recovery contract or interface family is invalid`);
  }
  if (envelope.arrival_class !== 'recovery_backlog') {
    refuse(`${family} recovery arrival_class must be recovery_backlog`);
  }
  if (requireUuid(envelope.tenant_id, 'recovery.tenant_id') !== authenticatedTenantId) {
    refuse(`${family} recovery tenant does not match the authenticated tenant`);
  }
  requireClockEvidence(envelope.clock_evidence);
  return {
    tenantId: authenticatedTenantId,
    offsetId: requireUuid(envelope.offset_id, 'offset_id'),
    generation: requirePositiveInt(envelope.generation, 'generation'),
    sourcePosition: requirePosition(envelope.source_position, 'source_position'),
    predecessorToken: requireText(envelope.predecessor_token, 'predecessor_token'),
    sourceObservedAt: requireTimestamp(envelope.source_observed_at, 'source_observed_at'),
    sourceReceivedAt: requireTimestamp(envelope.source_received_at, 'source_received_at'),
  };
}

export async function validateI01OruRecovery({ tenantId, message, recovery, context = {} }, { tx }) {
  const envelope = requireClosedObject(recovery, I01_RECOVERY_KEYS, 'recovery');
  const common = assertCommonEnvelope(envelope, {
    tenantId,
    family: 'I01',
    contract: I01_ORU_SEQUENCE_CONTRACT,
  });
  const rawMessage = requireText(message, 'message', 2_000_000);
  const parsed = parseHL7(rawMessage);
  if (!parsed.msh) refuse('I01 message lacks MSH');
  assertSupportedOruEnvelope(parsed);
  const messageControlId = requireText(parsed.msh.messageControlId, 'MSH-10', 100);
  const sendingApp = requireText(parsed.msh.sendingApp, 'MSH-3', 120);
  const patientUid = requireUuid(parsed.pid?.patientId || parsed.pid?.uid, 'PID-3');
  const obxRows = normalizeOruObxRows(parsed);
  const occurredAt = parseHl7Occurrence(parsed.obr?.orderDateTime);
  if (occurredAt !== common.sourceObservedAt) {
    refuse('source_observed_at does not exactly match OBR-7');
  }
  const trusted = await resolveTrustedOruChannel({
    tx,
    tenantId: common.tenantId,
    sendingApp,
    actorUid: context.actorUid || null,
    actorRole: context.actorRole || null,
    actorRoles: context.actorRoles || [],
    apiClient: context.apiClient || null,
    apiClientId: context.apiClientId || null,
    apiClientTenantId: context.apiClientTenantId || null,
  });
  if (envelope.trusted_sender_identity !== trusted.analyzer.analyzer_code) {
    refuse('trusted_sender_identity does not match the authenticated ORU channel');
  }
  if (envelope.message_control_id !== messageControlId) {
    refuse('message_control_id does not match MSH-10');
  }
  const payloadSha256 = sha256Utf8(rawMessage);
  if (requireSha(envelope.message_sha256, 'message_sha256') !== payloadSha256) {
    refuse('message_sha256 does not match the message bytes');
  }
  const expectedPartition = `i01/sender/${sha256Utf8(trusted.analyzer.analyzer_code.toLowerCase()).slice(0, 32)}`;
  if (envelope.source_partition !== expectedPartition) {
    refuse('I01 source_partition does not match the trusted sender identity');
  }
  const duplicateKey = i01DuplicateKey({
    tenantId: common.tenantId,
    trustedSenderIdentity: trusted.analyzer.analyzer_code,
    messageControlId,
  });
  if (envelope.duplicate_key !== duplicateKey) refuse('I01 duplicate_key is not canonical');
  const expectedSourceToken = sourceToken('I01', {
    tenantId: common.tenantId,
    sourcePartition: expectedPartition,
    generation: common.generation,
    sourcePosition: common.sourcePosition,
    predecessorToken: common.predecessorToken,
    duplicateKey,
    payloadSha256,
  });
  if (envelope.source_token !== expectedSourceToken) refuse('I01 source_token is not canonical');
  const orderSegment = (parsed.segments || []).find(segment => segment.type === 'ORC');
  const orcOrderId = String(orderSegment?.fields?.[2] || '').trim();
  const obrOrderId = String(parsed.obr?.placerOrderNumber || '').trim();
  if (orcOrderId && obrOrderId && orcOrderId !== obrOrderId) {
    refuse('ORU order identifiers do not agree');
  }
  const orderIdentity = parseOruOrderIdentity(orcOrderId || obrOrderId);
  await resolveLateOruSource({
    tx,
    tenantId: common.tenantId,
    patientUid,
    investigationId: orderIdentity.investigationId,
    obrTestIdentity: parsed.obr?.testCode,
    obxRows,
  });
  await assertConfiguredCriticalAnalytesNumeric({
    client: tx,
    tenantId: common.tenantId,
    results: obxRows.map(obx => ({
      loinc_code: obx.loincCode,
      test_code: obx.testCode,
      value_numeric: strictNumericOrNull(obx.value),
    })),
  });
  return Object.freeze({
    offsetId: common.offsetId,
    interfaceFamily: 'I01',
    sourcePartition: expectedPartition,
    generation: common.generation,
    sourcePosition: common.sourcePosition,
    sourceToken: expectedSourceToken,
    predecessorToken: common.predecessorToken,
    duplicateKey,
    occurredAt,
    command: {
      kind: 'i01',
      message: rawMessage,
      patient_uid: patientUid,
      source_received_at: common.sourceReceivedAt,
      actor_uid: String(trusted.actor.uid),
      actor_role: trusted.databaseActorRole,
      actor_roles: trusted.authenticatedActorRoles,
      api_client_id: context.apiClientId == null ? null : String(context.apiClientId),
      api_client_tenant_id: context.apiClientTenantId == null
        ? null
        : String(context.apiClientTenantId),
    },
  });
}

export async function validateI02AstmRecovery({
  tenantId, message, analyzerCode, recovery, context = {},
}, { tx }) {
  const envelope = requireClosedObject(recovery, I02_RECOVERY_KEYS, 'recovery');
  const common = assertCommonEnvelope(envelope, {
    tenantId,
    family: 'I02',
    contract: I02_ASTM_SEQUENCE_CONTRACT,
  });
  const rawMessage = requireText(message, 'message', 2_000_000);
  const parsed = parseAstmMessage(rawMessage);
  if (parsed.errors.length) {
    refuse(`ASTM message unusable: ${parsed.errors.join('; ')}`);
  }
  const actor = await groundLabInterfaceActor({ tx, tenantId: common.tenantId, context });
  const trusted = await resolveTrustedAstmAnalyzer({
    tx,
    tenantId: common.tenantId,
    analyzerCode: String(analyzerCode || '').trim(),
    parsed,
    apiClientId: context.apiClientId || null,
    apiClientTenantId: context.apiClientTenantId || null,
    actorUid: actor.actorUid,
    actorRoles: actor.actorRoles,
  });
  const analyzerId = requirePositiveInt(envelope.analyzer_id, 'analyzer_id');
  if (
    analyzerId !== Number(trusted.analyzer.id)
    || envelope.analyzer_code !== trusted.analyzer.analyzer_code
    || envelope.analyzer_sender_identity !== trusted.senderIdentity
  ) {
    refuse('I02 recovery analyzer provenance does not match the authenticated channel');
  }
  const rawMessageSha256 = sha256Utf8(rawMessage);
  const astmMessageSha256 = sha256Utf8(astmCanonicalMessage(rawMessage));
  if (requireSha(envelope.raw_message_sha256, 'raw_message_sha256') !== rawMessageSha256) {
    refuse('raw_message_sha256 does not match the message bytes');
  }
  if (requireSha(envelope.astm_message_sha256, 'astm_message_sha256') !== astmMessageSha256) {
    refuse('astm_message_sha256 does not match the canonical ASTM bytes');
  }
  const expectedPartition = `i02/analyzer/${analyzerId}`;
  if (envelope.source_partition !== expectedPartition) {
    refuse('I02 source_partition does not match analyzer_id');
  }
  const duplicateKey = i02DuplicateKey({
    tenantId: common.tenantId,
    analyzerId,
    astmMessageSha256,
  });
  if (envelope.duplicate_key !== duplicateKey) refuse('I02 duplicate_key is not canonical');
  const expectedSourceToken = sourceToken('I02', {
    tenantId: common.tenantId,
    sourcePartition: expectedPartition,
    generation: common.generation,
    sourcePosition: common.sourcePosition,
    predecessorToken: common.predecessorToken,
    duplicateKey,
    payloadSha256: astmMessageSha256,
  });
  if (envelope.source_token !== expectedSourceToken) refuse('I02 source_token is not canonical');
  await resolveLateAstmSource({ tx, tenantId: common.tenantId, accession: parsed.accession });
  await assertConfiguredCriticalAnalytesNumeric({
    client: tx,
    tenantId: common.tenantId,
    results: parsed.results,
  });
  return Object.freeze({
    offsetId: common.offsetId,
    interfaceFamily: 'I02',
    sourcePartition: expectedPartition,
    generation: common.generation,
    sourcePosition: common.sourcePosition,
    sourceToken: expectedSourceToken,
    predecessorToken: common.predecessorToken,
    duplicateKey,
    occurredAt: common.sourceObservedAt,
    command: {
      kind: 'i02',
      message: rawMessage,
      analyzer_code: trusted.analyzer.analyzer_code,
      source_received_at: common.sourceReceivedAt,
      actor_uid: actor.actorUid,
      actor_role: actor.actorRole,
      actor_roles: actor.actorRoles,
      api_client_id: context.apiClientId == null ? null : String(context.apiClientId),
      api_client_tenant_id: context.apiClientTenantId == null
        ? null
        : String(context.apiClientTenantId),
    },
  });
}

function sourceMismatch() {
  return AppError.badRequest(
    'Recovered laboratory source does not match its patient/order evidence',
    'LAB_RESULT_SOURCE_MISMATCH',
  );
}

async function resolveLateOruSource({
  tx, tenantId, patientUid, investigationId, obrTestIdentity, obxRows,
}) {
  if (investigationId == null) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT uid::text, name
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid
          AND role = 'PATIENT' AND is_active = TRUE
          AND status = 'active' AND is_deleted = FALSE
        LIMIT 1 FOR SHARE`,
      tenantId,
      patientUid,
    );
    if (!rows[0]) throw sourceMismatch();
    return {
      bookingId: null,
      investigationId: null,
      admissionId: null,
      patientUid: rows[0].uid,
      patientName: rows[0].name || null,
    };
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT investigation.id, investigation.patient_uid::text,
            investigation.test_code, investigation.admission_id,
            patient.name
       FROM investigations AS investigation
       JOIN users AS patient
         ON patient.tenant_id = investigation.tenant_id
        AND patient.uid = investigation.patient_uid
        AND patient.role = 'PATIENT' AND patient.is_active = TRUE
        AND patient.status = 'active' AND patient.is_deleted = FALSE
      WHERE investigation.tenant_id = $1::uuid
        AND investigation.id = $2::integer
      LIMIT 1
      FOR SHARE OF investigation, patient`,
    tenantId,
    investigationId,
  );
  const source = rows[0];
  const orderedTestCode = String(source?.test_code || '').trim();
  const obrTestCode = String(obrTestIdentity || '').split('^', 1)[0].trim();
  if (
    !source
    || source.patient_uid.toLowerCase() !== patientUid.toLowerCase()
    || !orderedTestCode
    || obrTestCode !== orderedTestCode
    || obxRows.some(row => row.testCode !== orderedTestCode)
  ) {
    throw sourceMismatch();
  }
  return {
    bookingId: null,
    investigationId: Number(source.id),
    admissionId: source.admission_id == null ? null : Number(source.admission_id),
    patientUid: source.patient_uid,
    patientName: source.name || null,
  };
}

async function resolveLateAstmSource({ tx, tenantId, accession }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT specimen.id, specimen.patient_uid::text, specimen.booking_id,
            specimen.accession_number, specimen.barcode, specimen.status,
            patient.name AS patient_name,
            booking.investigation_id,
            investigation.admission_id
       FROM lab_specimens AS specimen
       JOIN users AS patient
         ON patient.tenant_id = specimen.tenant_id
        AND patient.uid = specimen.patient_uid
        AND patient.role = 'PATIENT' AND patient.is_active = TRUE
        AND patient.status = 'active' AND patient.is_deleted = FALSE
       LEFT JOIN investigation_bookings AS booking
         ON booking.tenant_id = specimen.tenant_id
        AND booking.id = specimen.booking_id
        AND booking.patient_id = patient.id
       LEFT JOIN investigations AS investigation
         ON investigation.tenant_id = specimen.tenant_id
        AND investigation.id = booking.investigation_id
        AND investigation.patient_uid = specimen.patient_uid
      WHERE specimen.tenant_id = $1::uuid
        AND (UPPER(specimen.accession_number) = UPPER($2)
          OR UPPER(specimen.barcode) = UPPER($2))
      ORDER BY specimen.id
      LIMIT 2
      FOR SHARE OF specimen, patient`,
    tenantId,
    accession,
  );
  if (rows.length !== 1) throw sourceMismatch();
  const source = rows[0];
  if (source.booking_id != null && source.investigation_id == null) throw sourceMismatch();
  return {
    specimen: source,
    bookingId: source.booking_id == null ? null : Number(source.booking_id),
    investigationId: source.investigation_id == null ? null : Number(source.investigation_id),
    admissionId: source.admission_id == null ? null : Number(source.admission_id),
  };
}

async function recordRecoveredResultEvent({
  tx, tenantId, patientUid, result, actorUid, actorRole, family, recoveryInboxId,
}) {
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    encounterId: null,
    eventType: 'lab.result_recorded',
    eventSubtype: 'lab',
    eventStatus: 'pending_review',
    sourceTable: 'lab_results',
    sourceId: String(result.id),
    resourceType: 'lab_result',
    resourceId: String(result.id),
    actorUid,
    actorRole,
    occurredAt: result.performed_at,
    visibleToPatient: false,
    summary: `Late ${family} laboratory result recovered — pending human review`,
    payload: {
      test_code: result.test_code,
      test_name: result.test_name,
      value_text: result.value_text,
      unit: result.unit,
      is_critical: result.is_critical,
      recovery_inbox_id: recoveryInboxId,
      interface_family: family,
      effect_disposition: 'late_pending_only',
    },
    afterState: { status: result.status, is_critical: result.is_critical },
    tags: ['lab', 'late-recovery', 'pending-review', family.toLowerCase()],
    timelineIdempotencyKey: `lab_results:${result.id}:late-recovery`,
    auditIdempotencyKey: `lab_results:${result.id}:audit:late-recovery`,
  }, { db: tx });
}

async function createRecoveryReviewTask({
  tx, tenantId, patientUid, resourceType, resourceId, family,
  recoveryInboxId, criticalResultIds, actorUid,
}) {
  return createTask({
    tenantId,
    taskKind: 'review',
    title: criticalResultIds.length
      ? `Review recovered critical ${family} laboratory results`
      : `Review recovered ${family} laboratory results`,
    description: 'Late recovered results require human review. Do not infer a retrospective SLA breach, pathway transition, or patient notification.',
    patientUid,
    relatedResourceType: resourceType,
    relatedResourceId: String(resourceId),
    priority: criticalResultIds.length ? 'critical' : 'high',
    assignedToRole: 'DUTY_DOCTOR',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: family,
      recovery_inbox_id: recoveryInboxId,
      critical_result_ids: [...criticalResultIds].sort((a, b) => a - b),
      owner_reconciliation_required: true,
    },
  });
}

async function persistI01({ tx, tenantId, recoveryInboxId, occurredAt, command }) {
  const parsed = parseHL7(command.message);
  assertSupportedOruEnvelope(parsed);
  const obxRows = normalizeOruObxRows(parsed);
  const messageControlId = requireText(parsed.msh?.messageControlId, 'MSH-10', 100);
  const sendingApp = requireText(parsed.msh?.sendingApp, 'MSH-3', 120);
  const patientUid = requireUuid(parsed.pid?.patientId || parsed.pid?.uid, 'PID-3');
  if (parseHl7Occurrence(parsed.obr?.orderDateTime) !== new Date(occurredAt).toISOString()) {
    refuse('I01 occurrence evidence drifted before persistence');
  }
  const trusted = await resolveTrustedOruChannel({
    tx,
    tenantId,
    sendingApp,
    actorUid: command.actor_uid,
    actorRole: command.actor_role,
    actorRoles: command.actor_roles,
    apiClientId: command.api_client_id,
    apiClientTenantId: command.api_client_tenant_id,
  });
  const orderSegment = (parsed.segments || []).find(segment => segment.type === 'ORC');
  const orderIdentity = parseOruOrderIdentity(
    String(orderSegment?.fields?.[2] || '').trim()
      || String(parsed.obr?.placerOrderNumber || '').trim(),
  );
  const source = await resolveLateOruSource({
    tx,
    tenantId,
    patientUid,
    investigationId: orderIdentity.investigationId,
    obrTestIdentity: parsed.obr?.testCode,
    obxRows,
  });
  await assertConfiguredCriticalAnalytesNumeric({
    client: tx,
    tenantId,
    results: obxRows.map(obx => ({
      loinc_code: obx.loincCode,
      test_code: obx.testCode,
      value_numeric: strictNumericOrNull(obx.value),
    })),
  });
  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO lab_oru_ingest_messages
       (tenant_id, trusted_sender_identity, message_control_id, raw_message,
        obx_count, authenticated_actor_uid, authenticated_actor_roles,
        sender_binding_mode, sender_binding_identity, recovery_inbox_id,
        recovery_interface_family)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::integer, $6::uuid,
        $7::text[], $8::text, $9::text, $10::uuid, 'I01')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    tenantId,
    trusted.analyzer.analyzer_code,
    messageControlId,
    command.message,
    obxRows.length,
    trusted.actor.uid,
    trusted.authenticatedActorRoles,
    trusted.bindingMode,
    trusted.bindingIdentity,
    recoveryInboxId,
  );
  const receipt = receipts[0];
  if (!receipt) refuse('I01 receipt identity already exists outside this recovery item', 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT');
  const results = [];
  for (const obx of obxRows) {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, booking_id, investigation_id, admission_id,
          patient_uid, patient_name, hl7_message_id, hl7_segment_index,
          oru_ingest_message_id, loinc_code, test_code, test_name, value_text,
          value_numeric, unit, reference_range, abnormal_flag, status,
          performed_by_lab, performed_at, received_at, raw_obx, analyzer_id)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::uuid,
          $6::text, $7::text, $8::integer, $9::bigint, $10::text, $11::text,
          $12::text, $13::text, $14::numeric, $15::text, $16::text, $17::text,
          $18::text, $19::text, $20::timestamptz, $21::timestamptz,
          $22::text, $23::integer)
       RETURNING *`,
      tenantId,
      source.bookingId,
      source.investigationId,
      source.admissionId,
      source.patientUid,
      source.patientName,
      messageControlId,
      obx.segmentId,
      receipt.id,
      obx.loincCode,
      obx.testCode,
      obx.testName,
      obx.value || null,
      strictNumericOrNull(obx.value),
      obx.units || null,
      obx.referenceRange || null,
      obx.abnormalFlag || null,
      obx.resultStatus === 'F' ? 'final' : 'preliminary',
      trusted.analyzer.analyzer_code,
      occurredAt,
      command.source_received_at,
      obx.raw,
      Number(trusted.analyzer.id),
    );
    const result = inserted[0];
    const criticality = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    if (criticality.breached === true) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE lab_results SET is_critical = TRUE, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer RETURNING *`,
        tenantId,
        Number(result.id),
      );
      Object.assign(result, updated[0]);
    }
    await recordRecoveredResultEvent({
      tx,
      tenantId,
      patientUid: source.patientUid,
      result,
      actorUid: trusted.actor.uid,
      actorRole: trusted.databaseActorRole,
      family: 'I01',
      recoveryInboxId,
    });
    results.push(result);
  }
  const resultIds = results.map(result => Number(result.id)).sort((a, b) => a - b);
  const criticalResultIds = results.filter(result => result.is_critical)
    .map(result => Number(result.id)).sort((a, b) => a - b);
  const task = await createRecoveryReviewTask({
    tx,
    tenantId,
    patientUid: source.patientUid,
    resourceType: 'lab_oru_ingest_message',
    resourceId: receipt.id,
    family: 'I01',
    recoveryInboxId,
    criticalResultIds,
    actorUid: trusted.actor.uid,
  });
  const completed = await tx.$queryRawUnsafe(
    `UPDATE lab_oru_ingest_messages
        SET status = 'completed', result_ids = $3::integer[],
            critical_result_ids = $4::integer[], recovery_pending_task_id = $5::integer,
            completed_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint AND status = 'processing'
      RETURNING *`,
    tenantId,
    receipt.id,
    resultIds,
    criticalResultIds,
    Number(task.id),
  );
  if (!completed[0]) refuse('I01 recovery receipt completion fence was lost');
  return Object.freeze({
    result: results[0],
    results,
    task,
    receipt: completed[0],
    outcomeCode: 'i01_lab_results_pending_review',
  });
}

async function persistI02({ tx, tenantId, recoveryInboxId, occurredAt, command }) {
  const parsed = parseAstmMessage(command.message);
  if (parsed.errors.length) refuse(`ASTM evidence drifted before persistence: ${parsed.errors.join('; ')}`);
  const actor = await groundLabInterfaceActor({ tx, tenantId, context: {
    actorUid: command.actor_uid,
    actorRole: command.actor_role,
    actorRoles: command.actor_roles,
  } });
  const trusted = await resolveTrustedAstmAnalyzer({
    tx,
    tenantId,
    analyzerCode: command.analyzer_code,
    parsed,
    apiClientId: command.api_client_id,
    apiClientTenantId: command.api_client_tenant_id,
    actorUid: actor.actorUid,
    actorRoles: actor.actorRoles,
  });
  const source = await resolveLateAstmSource({ tx, tenantId, accession: parsed.accession });
  await assertConfiguredCriticalAnalytesNumeric({ client: tx, tenantId, results: parsed.results });
  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_id, analyzer_code, direction, protocol, message_type,
        raw_message, status, ingest_contract_version, authenticated_actor_uid,
        authenticated_actor_roles, analyzer_binding_mode,
        analyzer_binding_identity, analyzer_sender_identity, recovery_inbox_id,
        recovery_interface_family)
     VALUES ($1::uuid, $2::integer, $3::text, 'inbound', 'astm_e1394',
        'ASTM-RESULT', $4::text, 'received', 1, $5::uuid, $6::text[], $7::text,
        $8::text, $9::text, $10::uuid, 'I02')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    tenantId,
    Number(trusted.analyzer.id),
    trusted.analyzer.analyzer_code,
    command.message,
    actor.actorUid,
    actor.actorRoles,
    trusted.bindingMode,
    trusted.bindingIdentity,
    trusted.senderIdentity,
    recoveryInboxId,
  );
  const receipt = receipts[0];
  if (!receipt) refuse('I02 receipt identity already exists outside this recovery item', 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT');
  const results = [];
  const verdicts = [];
  for (let index = 0; index < parsed.results.length; index += 1) {
    const parsedResult = parsed.results[index];
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, booking_id, investigation_id, admission_id, patient_uid,
          patient_name, test_code, test_name, value_text, value_numeric, unit,
          reference_range, reference_range_low, reference_range_high,
          abnormal_flag, status, performed_by_lab, performed_at, specimen_id,
          analyzer_id, raw_obx, received_at, interface_message_id,
          interface_result_index)
       VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::uuid,
          $6::text, $7::text, $7::text, $8::text, $9::numeric, $10::text,
          $11::text, $12::numeric, $13::numeric, $14::text, 'preliminary',
          $15::text, $16::timestamptz, $17::integer, $18::integer, $19::text,
          $20::timestamptz, $21::integer, $22::integer)
       RETURNING *`,
      tenantId,
      source.bookingId,
      source.investigationId,
      source.admissionId,
      source.specimen.patient_uid,
      source.specimen.patient_name || null,
      parsedResult.test_code,
      parsedResult.value_text,
      parsedResult.value_numeric,
      parsedResult.unit,
      parsedResult.reference_range,
      parsedResult.reference_low,
      parsedResult.reference_high,
      parsedResult.abnormal_flag,
      trusted.analyzer.display_name || trusted.analyzer.analyzer_code,
      occurredAt,
      Number(source.specimen.id),
      Number(trusted.analyzer.id),
      JSON.stringify(parsedResult),
      command.source_received_at,
      Number(receipt.id),
      index + 1,
    );
    const result = inserted[0];
    const criticality = await evaluateCriticalThreshold({ client: tx, tenantId, result });
    if (criticality.breached === true) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE lab_results SET is_critical = TRUE, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer RETURNING *`,
        tenantId,
        Number(result.id),
      );
      Object.assign(result, updated[0]);
    }
    const verdict = {
      ...await verdictForResult({
        client: tx,
        tenantId,
        interfaceMessageId: Number(receipt.id),
        patientUid: source.specimen.patient_uid,
        testCode: result.test_code,
        testName: result.test_name,
        valueNumeric: result.value_numeric == null ? null : Number(result.value_numeric),
        abnormalFlag: result.abnormal_flag,
        referenceLow: result.reference_range_low == null ? null : Number(result.reference_range_low),
        referenceHigh: result.reference_range_high == null ? null : Number(result.reference_range_high),
        criticality,
      }),
      interface_result_index: index + 1,
    };
    await recordRecoveredResultEvent({
      tx,
      tenantId,
      patientUid: source.specimen.patient_uid,
      result,
      actorUid: actor.actorUid,
      actorRole: actor.actorRole,
      family: 'I02',
      recoveryInboxId,
    });
    results.push(result);
    verdicts.push(verdict);
  }
  const criticalResultIds = results.filter(result => result.is_critical)
    .map(result => Number(result.id)).sort((a, b) => a - b);
  const task = await createRecoveryReviewTask({
    tx,
    tenantId,
    patientUid: source.specimen.patient_uid,
    resourceType: 'lab_interface_message',
    resourceId: receipt.id,
    family: 'I02',
    recoveryInboxId,
    criticalResultIds,
    actorUid: actor.actorUid,
  });
  const pending = await tx.$queryRawUnsafe(
    `UPDATE lab_interface_messages
        SET status = 'pending_review', result_count = $3::integer,
            specimen_id = $4::integer, verdicts = $5::jsonb,
            recovery_critical_result_ids = $6::integer[],
            recovery_pending_task_id = $7::integer, processed_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer AND status = 'received'
      RETURNING *`,
    tenantId,
    Number(receipt.id),
    results.length,
    Number(source.specimen.id),
    JSON.stringify(verdicts),
    criticalResultIds,
    Number(task.id),
  );
  if (!pending[0]) refuse('I02 recovery receipt pending-review fence was lost');
  return Object.freeze({
    result: results[0],
    results,
    task,
    receipt: pending[0],
    outcomeCode: 'i02_lab_results_pending_review',
  });
}

export async function persistLateLabRecovery({
  tx, capability, tenantId, interfaceFamily, recoveryInboxId, occurredAt, command,
}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') throw new TypeError('A transaction client is required');
  requireExternalRecoveryCapability(capability, {
    tenantId,
    facilityId: null,
    interfaceFamily,
    effectDisposition: 'late_pending_only',
  });
  if (command?.kind !== interfaceFamily.toLowerCase()) {
    refuse('Recovery command family does not match its laboratory adapter');
  }
  if (interfaceFamily === 'I01') {
    return persistI01({ tx, tenantId, recoveryInboxId, occurredAt, command });
  }
  if (interfaceFamily === 'I02') {
    return persistI02({ tx, tenantId, recoveryInboxId, occurredAt, command });
  }
  throw new TypeError('Laboratory recovery supports I01 or I02');
}

function toOperation(tenantId, prepared) {
  return {
    tenantId,
    offsetId: prepared.offsetId,
    interfaceFamily: prepared.interfaceFamily,
    sourcePartition: prepared.sourcePartition,
    generation: prepared.generation,
    sourcePosition: prepared.sourcePosition,
    sourceToken: prepared.sourceToken,
    predecessorToken: prepared.predecessorToken,
    duplicateKey: prepared.duplicateKey,
    occurredAt: prepared.occurredAt,
    command: prepared.command,
  };
}

async function enqueueAndProcess(operation) {
  const queued = await enqueueExternalRecoveryItem(operation);
  if (queued.held) {
    throw AppError.conflict(
      'Canonical laboratory recovery marker is missing; owner reconciliation is required',
      'EXTERNAL_RECOVERY_MARKER_MISSING',
    );
  }
  return queued.duplicate ? queued : processNextItemTx(operation);
}

export async function ingestSequencedOruRecovery(input = {}, context = {}) {
  const prepared = await setTenantTx(input.tenantId, tx => validateI01OruRecovery({
    tenantId: input.tenantId,
    message: input.message,
    recovery: input.recovery,
    context,
  }, { tx }));
  return enqueueAndProcess(toOperation(input.tenantId, prepared));
}

export async function ingestSequencedAstmRecovery(input = {}, context = {}) {
  const prepared = await setTenantTx(input.tenantId, tx => validateI02AstmRecovery({
    tenantId: input.tenantId,
    message: input.message,
    analyzerCode: input.analyzerCode,
    recovery: input.recovery,
    context,
  }, { tx }));
  return enqueueAndProcess(toOperation(input.tenantId, prepared));
}

export default Object.freeze({
  validateI01OruRecovery,
  validateI02AstmRecovery,
  persistLateLabRecovery,
  ingestSequencedOruRecovery,
  ingestSequencedAstmRecovery,
  i01DuplicateKey,
  i02DuplicateKey,
  i01SourceToken,
  i02SourceToken,
  astmCanonicalMessage,
});
