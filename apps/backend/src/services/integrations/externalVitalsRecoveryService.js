import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { fhirObservationToVitals, obxResultsToVitals } from '../fhir/observationVitalsMapper.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { assertLateRecoveryVitalsBoundary } from '../emr/vitalsChartService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

export const I09_GATEWAY_SEQUENCE_CONTRACT = 'vhhealth.i09.gateway-sequence/v1';
export const I15_FHIR_SEQUENCE_CONTRACT = 'vhhealth.i15.fhir-write-sequence/v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const POSITION_RE = /^(0|[1-9][0-9]*)$/;
const I09_RECOVERY_KEYS = new Set([
  'schema', 'interface_family', 'arrival_class', 'tenant_id',
  'gateway_registry_id', 'device_registry_id', 'offset_id', 'source_partition',
  'generation', 'source_position', 'source_token', 'predecessor_token', 'msh10',
  'duplicate_key', 'message_sha256', 'gateway_received_at', 'clock_evidence',
]);
const I15_RECOVERY_KEYS = new Set([
  'schema', 'interface_family', 'arrival_class', 'tenant_id', 'api_client_id',
  'offset_id', 'source_partition', 'generation', 'source_position', 'source_token',
  'predecessor_token', 'event_identity', 'duplicate_key', 'resource_sha256',
  'client_received_at', 'clock_evidence',
]);
const VITAL_COLUMNS = Object.freeze([
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg', 'height_cm',
  'gcs_score',
]);

function refuse(message, code = 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) refuse(`${label} contains unknown fields`, 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED', { unexpected });
  return value;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requirePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) refuse(`${label} must be a positive integer`);
  return number;
}

function requireText(value, label, max = 255) {
  const text = String(value ?? '');
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
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
  if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(text)) refuse(`${label} must carry an explicit UTC offset`);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('FHIR resource contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  refuse('FHIR resource contains an unsupported value');
}

export function sha256Utf8(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

export function canonicalResourceSha256(resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) refuse('FHIR resource must be an object');
  return sha256Utf8(JSON.stringify(canonicalize(resource)));
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

export function i09DuplicateKey({ tenantId, deviceRegistryId, msh10 }) {
  return lengthPrefixedSha256([
    'vh-i09-duplicate-v1',
    String(tenantId).toLowerCase(),
    String(Number(deviceRegistryId)),
    String(msh10),
  ]);
}

export function i09SourceToken({
  tenantId,
  sourcePartition,
  generation,
  sourcePosition,
  predecessorToken,
  duplicateKey,
  messageSha256,
}) {
  return lengthPrefixedSha256([
    'vh-i09-source-token-v1',
    String(tenantId).toLowerCase(),
    sourcePartition,
    String(Number(generation)),
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256,
  ]);
}

function parseHl7Occurrence(raw) {
  const value = String(raw || '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) refuse('OBR-7 source occurrence must include seconds and an explicit UTC offset', 'EXTERNAL_RECOVERY_OCCURRENCE_REQUIRED');
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  return requireTimestamp(`${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`, 'OBR-7 source occurrence');
}

function extractOru(parsed) {
  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const pid = segments.find((segment) => segment.type === 'PID');
  const rawPatient = String(pid?.fields?.[3] ?? pid?.fields?.[2] ?? '').split('^')[0].split('~')[0].trim();
  const patientUid = UUID_RE.test(rawPatient) ? rawPatient.toLowerCase() : null;
  const observations = segments.filter((segment) => segment.type === 'OBX').map((segment) => {
    const fields = segment.fields || [];
    const valueText = String(fields[5] ?? '').trim();
    return {
      loinc_code: String(fields[3] ?? '').split('^')[0].trim(),
      value_numeric: Number.parseFloat(valueText),
      value_text: valueText,
    };
  });
  return { patientUid, observations };
}

async function activeDevice(tx, tenantId, id, label) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, device_code, kind, status
       FROM device_registry
      WHERE tenant_id = $1::uuid AND id = $2::integer AND status = 'active'
      LIMIT 1`,
    tenantId, id,
  );
  if (rows.length !== 1) refuse(`${label} is not an active tenant device`, 'EXTERNAL_RECOVERY_DEVICE_REFUSED');
  return rows[0];
}

export async function validateI09GatewayRecovery({ tenantId, message, deviceCode, patientUid, channel, recovery }, { tx }) {
  const envelope = requireClosedObject(recovery, I09_RECOVERY_KEYS, 'recovery');
  if (envelope.schema !== I09_GATEWAY_SEQUENCE_CONTRACT || envelope.interface_family !== 'I09') {
    refuse('I09 gateway recovery contract or interface family is invalid');
  }
  if (envelope.arrival_class !== 'recovery_backlog') refuse('I09 recovery arrival_class must be recovery_backlog');
  const authenticatedTenantId = requireUuid(tenantId, 'authenticated tenant_id');
  if (requireUuid(envelope.tenant_id, 'recovery.tenant_id') !== authenticatedTenantId) {
    refuse('I09 recovery tenant does not match the authenticated tenant');
  }
  const gatewayRegistryId = requirePositiveInt(envelope.gateway_registry_id, 'gateway_registry_id');
  const deviceRegistryId = requirePositiveInt(envelope.device_registry_id, 'device_registry_id');
  const gateway = await activeDevice(tx, authenticatedTenantId, gatewayRegistryId, 'gateway_registry_id');
  const device = await activeDevice(tx, authenticatedTenantId, deviceRegistryId, 'device_registry_id');
  if (
    gatewayRegistryId === deviceRegistryId
    || gateway.kind !== 'monitor_gateway'
    || device.kind !== 'monitor'
  ) {
    refuse(
      'I09 recovery requires distinct monitor_gateway and monitor device identities',
      'EXTERNAL_RECOVERY_DEVICE_REFUSED',
    );
  }
  const expectedPartition = `i09/gateway/${gatewayRegistryId}/device/${deviceRegistryId}`;
  if (envelope.source_partition !== expectedPartition) refuse('I09 source_partition does not match gateway/device identity');
  if (String(deviceCode || '') !== String(device.device_code)) refuse('device_code does not match device_registry_id');
  const rawMessage = requireText(message, 'message', 2_000_000);
  if (!rawMessage.startsWith('MSH|')) refuse('I09 message must be an HL7 payload');
  const parsed = parseHL7(rawMessage);
  const msh10 = requireText(parsed.msh?.messageControlId, 'MSH-10', 255);
  if (envelope.msh10 !== msh10) refuse('recovery.msh10 does not match the HL7 message');
  const messageSha = sha256Utf8(rawMessage);
  if (requireSha(envelope.message_sha256, 'message_sha256') !== messageSha) refuse('message_sha256 does not match the message bytes');
  const duplicateKey = i09DuplicateKey({ tenantId: authenticatedTenantId, deviceRegistryId, msh10 });
  if (envelope.duplicate_key !== duplicateKey) refuse('I09 duplicate_key is not canonical');
  const sourcePosition = requirePosition(envelope.source_position, 'source_position');
  const predecessorToken = requireText(envelope.predecessor_token, 'predecessor_token');
  const sourceToken = i09SourceToken({
    tenantId: authenticatedTenantId,
    sourcePartition: expectedPartition,
    generation: requirePositiveInt(envelope.generation, 'generation'),
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256: messageSha,
  });
  if (envelope.source_token !== sourceToken) refuse('I09 source_token is not canonical');
  requireTimestamp(envelope.gateway_received_at, 'gateway_received_at');
  if (!envelope.clock_evidence || typeof envelope.clock_evidence !== 'object' || Array.isArray(envelope.clock_evidence)) {
    refuse('clock_evidence must be an object');
  }
  const extracted = extractOru(parsed);
  const requestedPatient = patientUid ? requireUuid(patientUid, 'patient_uid') : null;
  if (requestedPatient && extracted.patientUid && requestedPatient !== extracted.patientUid) refuse('patient_uid does not match PID-3');
  const resolvedPatientUid = requestedPatient || extracted.patientUid;
  if (!resolvedPatientUid) refuse('I09 recovery requires patient_uid or UUID PID-3');
  const mapping = obxResultsToVitals(extracted.observations);
  if (Object.keys(mapping.vitals).length === 0) refuse('I09 recovery contains no mappable vital-sign OBX');
  return Object.freeze({
    interfaceFamily: 'I09',
    offsetId: requireUuid(envelope.offset_id, 'offset_id'),
    sourcePartition: expectedPartition,
    generation: Number(envelope.generation),
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    commandFingerprint: messageSha,
    occurredAt: parseHl7Occurrence(parsed.obr?.orderDateTime),
    command: Object.freeze({
      kind: 'i09', message: rawMessage, device_code: device.device_code,
      patient_uid: resolvedPatientUid, channel: String(channel || '').slice(0, 80),
      gateway_registry_id: gatewayRegistryId, device_registry_id: deviceRegistryId,
      msh10, mapped: mapping.mapped, unmapped: mapping.unmapped, vitals: mapping.vitals,
      actor_uid: null,
    }),
  });
}

function fhirPatientUid(resource) {
  const reference = String(resource?.subject?.reference || '');
  const match = /^Patient\/([0-9a-f-]{36})$/i.exec(reference);
  return match && UUID_RE.test(match[1]) ? match[1].toLowerCase() : null;
}

export function validateI15FhirRecovery({ tenantId, apiClientId, resource, recovery }) {
  const envelope = requireClosedObject(recovery, I15_RECOVERY_KEYS, 'recovery');
  if (envelope.schema !== I15_FHIR_SEQUENCE_CONTRACT || envelope.interface_family !== 'I15') {
    refuse('I15 FHIR recovery contract or interface family is invalid');
  }
  if (envelope.arrival_class !== 'recovery_backlog') refuse('I15 recovery arrival_class must be recovery_backlog');
  const authenticatedTenantId = requireUuid(tenantId, 'authenticated tenant_id');
  if (requireUuid(envelope.tenant_id, 'recovery.tenant_id') !== authenticatedTenantId) refuse('I15 recovery tenant does not match');
  const clientId = requireText(apiClientId, 'api_client_id', 120);
  if (envelope.api_client_id !== clientId) refuse('I15 recovery api_client_id does not match the authenticated client');
  if (resource?.resourceType !== 'Observation') refuse('I15 recovery accepts FHIR Observation only');
  const patientUid = fhirPatientUid(resource);
  if (!patientUid) refuse('FHIR Observation subject must be Patient/{uuid}');
  const mapping = fhirObservationToVitals(resource);
  if (Object.keys(mapping.vitals).length === 0) refuse('I15 recovery contains no mappable vital-sign LOINC');
  const occurredAt = requireTimestamp(mapping.effective, 'FHIR Observation effectiveDateTime or issued');
  const resourceSha = canonicalResourceSha256(resource);
  if (requireSha(envelope.resource_sha256, 'resource_sha256') !== resourceSha) refuse('resource_sha256 is not canonical');
  const eventIdentity = requireText(envelope.event_identity, 'event_identity', 255);
  const duplicateKey = lengthPrefixedSha256(['vh-i15-duplicate-v1', authenticatedTenantId, clientId, eventIdentity]);
  if (envelope.duplicate_key !== duplicateKey) refuse('I15 duplicate_key is not canonical');
  const sourcePosition = requirePosition(envelope.source_position, 'source_position');
  const predecessorToken = requireText(envelope.predecessor_token, 'predecessor_token');
  const partition = `i15/client/${clientId}/resource/Observation`;
  if (envelope.source_partition !== partition) refuse('I15 source_partition is not canonical');
  const sourceToken = lengthPrefixedSha256([
    'vh-i15-source-token-v1', authenticatedTenantId, partition,
    String(requirePositiveInt(envelope.generation, 'generation')), sourcePosition,
    predecessorToken, duplicateKey, resourceSha,
  ]);
  if (envelope.source_token !== sourceToken) refuse('I15 source_token is not canonical');
  requireTimestamp(envelope.client_received_at, 'client_received_at');
  return Object.freeze({
    interfaceFamily: 'I15', subpath: 'fhir_write',
    offsetId: requireUuid(envelope.offset_id, 'offset_id'), sourcePartition: partition,
    generation: Number(envelope.generation), sourcePosition, sourceToken,
    predecessorToken, duplicateKey, commandFingerprint: resourceSha, occurredAt,
    command: Object.freeze({ kind: 'i15', resource, patient_uid: patientUid,
      api_client_id: clientId, mapped: mapping.mapped, unmapped: mapping.unmapped,
      vitals: mapping.vitals, temperature_unit: mapping.temperatureUnit }),
  });
}

function normalizedVitals(command) {
  const vitals = command?.vitals || {};
  const output = {};
  for (const column of VITAL_COLUMNS) {
    const value = vitals[column];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (!Number.isFinite(number)) refuse(`${column} must be numeric`, 'EXTERNAL_RECOVERY_OBSERVATION_INVALID');
    output[column] = number;
  }
  if (Object.keys(output).length === 0) refuse('Late recovery must contain at least one vital', 'EXTERNAL_RECOVERY_OBSERVATION_INVALID');
  return output;
}

export async function persistLateVitalsRecovery({
  tx,
  capability,
  tenantId,
  interfaceFamily,
  recoveryInboxId,
  occurredAt,
  command,
}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') throw new TypeError('A transaction client is required');
  requireExternalRecoveryCapability(capability, {
    tenantId, facilityId: null, interfaceFamily,
    effectDisposition: 'late_pending_only',
  });
  if (!['I09', 'I15'].includes(interfaceFamily)) throw new TypeError('Vitals recovery supports I09 or I15');
  if (command?.kind !== interfaceFamily.toLowerCase()) refuse('Recovery command family does not match its adapter');
  const patientUid = requireUuid(command.patient_uid, 'patient_uid');
  const patientRows = await tx.$queryRawUnsafe(
    `SELECT uid::text FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT' LIMIT 1`,
    tenantId, patientUid,
  );
  if (patientRows.length !== 1) throw AppError.notFound('Recovery patient not found', 'EXTERNAL_RECOVERY_PATIENT_NOT_FOUND');
  const vitals = normalizedVitals(command);
  const source = interfaceFamily === 'I09' ? 'device' : 'fhir';
  assertLateRecoveryVitalsBoundary({
    interfaceFamily,
    source,
    deviceVerified: interfaceFamily === 'I09' ? false : null,
    triageAcuity: null,
  });
  let interfaceMessage = null;
  if (interfaceFamily === 'I09') {
    const gateway = await activeDevice(tx, tenantId, command.gateway_registry_id, 'gateway_registry_id');
    const device = await activeDevice(tx, tenantId, command.device_registry_id, 'device_registry_id');
    if (
      Number(gateway.id) === Number(device.id)
      || gateway.kind !== 'monitor_gateway'
      || device.kind !== 'monitor'
      || device.device_code !== command.device_code
    ) {
      refuse('I09 gateway or device evidence drifted before persistence');
    }
    const messages = await tx.$queryRawUnsafe(
      `INSERT INTO lab_interface_messages
         (tenant_id, analyzer_code, direction, protocol, message_type, raw_message,
          status, result_count, verdicts, authenticated_actor_uid,
          recovery_inbox_id, recovery_interface_family)
       VALUES ($1::uuid, $2::text, 'inbound', 'hl7v2', 'ORU^VITALS', $3::text,
          'ingested', $4::integer, $5::jsonb, $6::uuid, $7::uuid, 'I09')
       RETURNING id, raw_message_sha256`,
      tenantId, device.device_code, command.message, command.mapped.length,
      JSON.stringify({ mapped: command.mapped, unmapped: command.unmapped,
        msh10: command.msh10, gateway_registry_id: gateway.id, device_registry_id: device.id,
        effect_disposition: 'late_pending_only' }),
      command.actor_uid || null, recoveryInboxId,
    );
    interfaceMessage = messages[0];
  }
  const values = VITAL_COLUMNS.map((column) => vitals[column] ?? null);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO vitals_chart
       (tenant_id, patient_uid, heart_rate, systolic_bp, diastolic_bp, temperature,
        spo2, respiratory_rate, blood_glucose, pain_score, weight_kg, height_cm,
        gcs_score, supplemental_o2, notes, recorded_by, recorded_at, source,
        source_device, device_verified, triage_acuity,
        recovery_inbox_id, recovery_interface_family)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13::integer, false, $14::text, $15::uuid, $16::timestamptz,
        $17::text, $18::text, $19::boolean, NULL, $20::uuid, $21::text)
     RETURNING id, tenant_id::text, patient_uid::text, heart_rate, systolic_bp,
       diastolic_bp, temperature, spo2, respiratory_rate, blood_glucose,
       pain_score, weight_kg, height_cm, gcs_score, supplemental_o2, notes,
       recorded_by::text, recorded_at, source, source_device, device_verified,
       triage_acuity, recovery_inbox_id::text, recovery_interface_family`,
    tenantId, patientUid, ...values,
    `Late ${interfaceFamily} recovery observation (${(command.mapped || []).join(', ')})`,
    command.actor_uid || null, occurredAt, source,
    interfaceFamily === 'I09' ? command.device_code : command.api_client_id,
    interfaceFamily === 'I09' ? false : null,
    recoveryInboxId, interfaceFamily,
  );
  const observation = rows[0];
  await recordCanonicalClinicalEvent({
    tenantId, patientUid, eventType: 'vitals.recorded', eventStatus: 'pending_review',
    sourceTable: 'vitals_chart', sourceId: observation.id,
    resourceType: 'vitals', resourceId: observation.id,
    actorUid: command.actor_uid || null,
    summary: `Late ${interfaceFamily} vitals recovered — pending clinical review`,
    payload: { vitals: observation, source_kind: source, verification_status: 'pending_review',
      recovery_inbox_id: recoveryInboxId, interface_family: interfaceFamily,
      interface_message_id: interfaceMessage?.id ?? null },
    afterState: observation,
    tags: ['vitals', 'late-recovery', 'pending-review', interfaceFamily.toLowerCase()],
  }, { db: tx });
  const task = await createTask({
    tenantId, taskKind: 'review', title: `Review recovered ${interfaceFamily} vitals`,
    description: 'Late recovery evidence is observation-only. Review before any NEWS2, triage, alert, or pathway action.',
    patientUid, relatedResourceType: 'vitals_chart', relatedResourceId: String(observation.id),
    priority: 'normal', assignedToRole: 'NURSING_INCHARGE',
    createdBy: command.actor_uid || null, slaCompletionSemantics: 'none', tx,
    metadata: { contract: 'late_pending_only', interface_family: interfaceFamily,
      recovery_inbox_id: recoveryInboxId, interface_message_id: interfaceMessage?.id ?? null,
      owner_reconciliation_required: true },
  });
  return Object.freeze({
    observation,
    task,
    interfaceMessage,
    outcomeCode: `${interfaceFamily.toLowerCase()}_vitals_observation_pending_review`,
  });
}

export default Object.freeze({
  validateI09GatewayRecovery,
  validateI15FhirRecovery,
  persistLateVitalsRecovery,
  i09DuplicateKey,
  i09SourceToken,
  lengthPrefixedSha256,
});
