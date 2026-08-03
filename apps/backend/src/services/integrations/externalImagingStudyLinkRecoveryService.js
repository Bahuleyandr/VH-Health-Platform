import { createHash } from 'node:crypto';

import { encryptField } from '../../utils/fieldEncryption.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STUDY_UID_RE = /^[0-9]+(\.[0-9]+)+$/;
const PAYLOAD_KEYS = new Set([
  'schema',
  'radiology_order_id',
  'study_instance_uid',
  'accession_number',
  'source_system',
  'observed_at',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I06_STUDY_LINK_RECOVERY_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
}

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

export function parseI06StudyLinkPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I06 study-link payload is invalid JSON', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I06 study-link payload must be an object', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I06 study-link payload fields do not match the registered schema', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  if (payload.schema !== 'vhhealth.i06.study-link/v1') {
    refuse('I06 study-link payload schema is not registered', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  const orderId = Number(payload.radiology_order_id);
  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    refuse('radiology_order_id is invalid', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  const studyInstanceUid = requireText(payload.study_instance_uid, 'study_instance_uid', 200);
  if (!STUDY_UID_RE.test(studyInstanceUid)) {
    refuse('study_instance_uid must be a dotted-numeric DICOM UID', 'I06_STUDY_LINK_PAYLOAD_INVALID');
  }
  return Object.freeze({
    schema: payload.schema,
    radiologyOrderId: orderId,
    studyInstanceUid,
    accessionNumber: requireText(payload.accession_number, 'accession_number', 120),
    sourceSystem: requireText(payload.source_system, 'source_system', 120),
    observedAt: requireTimestamp(payload.observed_at, 'observed_at'),
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I06 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) refuse('I06 owner recovery command contains unknown fields', undefined, { unexpected });
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I06 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateImagingStudyLinkRecovery({
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
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I06 recovery requires the canonical recovery transaction', 'I06_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I06',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I06 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const payload = parseI06StudyLinkPayload(rawPayload);
  const payloadHash = sha256(rawPayload);
  if (input.payload_sha256 !== payloadHash) refuse('I06 raw payload hash does not match exact bytes');
  if (payload.observedAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I06 observed_at does not match the durable source occurrence');
  }
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const expectedPartition = `radiology-order:${payload.radiologyOrderId}:study-link`;
  const expectedDuplicate = `i06:study-link:${payload.radiologyOrderId}:${payload.studyInstanceUid}:${payloadHash}`;
  if (sourcePartition !== expectedPartition) refuse('I06 source partition does not match the radiology order');
  if (duplicateKey !== expectedDuplicate) refuse('I06 duplicate key does not match the exact study-link payload');

  const orders = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, patient_uid::text AS patient_uid,
            modality, body_part, status, pacs_study_instance_uid
       FROM radiology_orders
      WHERE tenant_id = $1::uuid AND id = $2::integer
      FOR UPDATE`,
    tid,
    payload.radiologyOrderId,
  );
  const order = orders[0];
  if (!order) refuse('I06 radiology order was not found', 'I06_RADIOLOGY_ORDER_NOT_FOUND');

  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO imaging_study_link_recovery_receipts
       (tenant_id, radiology_order_id, patient_uid, study_instance_uid,
        accession_number, source_system, observed_at, payload_ciphertext,
        payload_sha256, payload_bytes, source_partition, source_position,
        source_token, predecessor_token, duplicate_key, recovery_inbox_id,
        recovery_interface_family, owner_actor_uid, owner_reason, evidence)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::text,
             $5::text, $6::text, $7::timestamptz, $8::text,
             $9::char(64), $10::integer, $11::text, $12::bigint,
             $13::text, $14::text, $15::text, $16::uuid,
             'I06', $17::uuid, $18::text, $19::jsonb)
     RETURNING id::text, radiology_order_id, patient_uid::text,
               study_instance_uid, accession_number, source_system,
               observed_at, payload_sha256::text, payload_bytes,
               receipt_status, recovery_inbox_id::text, created_at`,
    tid,
    order.id,
    order.patient_uid,
    payload.studyInstanceUid,
    payload.accessionNumber,
    payload.sourceSystem,
    payload.observedAt,
    encryptField(rawPayload, { tenantId: tid }),
    payloadHash,
    Buffer.byteLength(rawPayload, 'utf8'),
    sourcePartition,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
    inboxId,
    actorUid,
    ownerReason,
    JSON.stringify({
      ...input.evidence,
      payload_schema: payload.schema,
      byte_parity_verified: true,
      order_link_changed: false,
      timeline_event_created: false,
      target_domain_effect_performed: false,
      existing_study_instance_uid: order.pacs_study_instance_uid || null,
    }),
  );

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: 'Review late PACS/DICOM study link',
    description: 'The exact late study-link bytes were retained as pending imaging review. The radiology order and clinical timeline were not changed.',
    relatedResourceType: 'radiology_order',
    relatedResourceId: String(order.id),
    priority: 'high',
    assignedToRole: 'RADIOLOGIST',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I06',
      subpath: 'study_link',
      recovery_inbox_id: inboxId,
      receipt_id: receipts[0].id,
      radiology_order_id: order.id,
      proposed_study_instance_uid: payload.studyInstanceUid,
      existing_study_instance_uid: order.pacs_study_instance_uid || null,
      byte_parity_verified: true,
      order_link_changed: false,
      timeline_event_created: false,
    },
  });

  return Object.freeze({
    order: Object.freeze(order),
    receipt: Object.freeze({ ...receipts[0], id: receipts[0].id }),
    task,
    outcomeCode: 'i06_study_link_pending_imaging_review',
  });
}

export default Object.freeze({
  parseI06StudyLinkPayload,
  persistLateImagingStudyLinkRecovery,
});
