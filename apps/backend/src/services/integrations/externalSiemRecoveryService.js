import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = new Set([
  'schema',
  'attempt_id',
  'event_id',
  'target_id',
  'attempt_number',
  'source_name',
  'source_id',
  'payload_sha256',
  'acknowledgement_state',
  'occurred_at',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I25_SIEM_RECOVERY_INVALID', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) refuse(`${label} must be a positive integer`);
  return parsed;
}

function requireSha256(value, label) {
  const text = String(value || '').trim();
  if (!SHA256_RE.test(text)) refuse(`${label} must be lowercase SHA-256`);
  return text;
}

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

export function parseI25SiemRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I25 SIEM recovery payload is invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I25 SIEM recovery payload must be an object');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I25 SIEM recovery payload fields do not match the registered schema');
  }
  if (payload.schema !== 'vhhealth.i25.siem-attempt-owner-reconciliation/v1') {
    refuse('I25 SIEM recovery payload schema is not registered');
  }
  const acknowledgementState = requireText(
    payload.acknowledgement_state,
    'acknowledgement_state',
    32,
  );
  if (acknowledgementState === 'positive') {
    refuse('A positively acknowledged I25 attempt is not eligible for late recovery');
  }
  return Object.freeze({
    schema: payload.schema,
    attemptId: requirePositiveInteger(payload.attempt_id, 'attempt_id'),
    eventId: requirePositiveInteger(payload.event_id, 'event_id'),
    targetId: requirePositiveInteger(payload.target_id, 'target_id'),
    attemptNumber: requirePositiveInteger(payload.attempt_number, 'attempt_number'),
    sourceName: requireText(payload.source_name, 'source_name', 80),
    sourceId: requireText(payload.source_id, 'source_id', 255),
    payloadSha256: requireSha256(payload.payload_sha256, 'payload_sha256'),
    acknowledgementState,
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I25 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) {
    refuse('I25 owner recovery command contains unknown fields', undefined, { unexpected });
  }
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I25 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateSiemAttemptRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  sourcePartition,
  sourcePosition,
  duplicateKey,
  occurredAt,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I25 recovery requires the canonical recovery transaction', 'I25_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I25',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I25 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const rawPayloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (requireSha256(input.payload_sha256, 'payload_sha256') !== rawPayloadHash) {
    refuse('I25 recovery payload hash does not match exact bytes');
  }
  const payload = parseI25SiemRecoveryPayload(rawPayload);
  if (payload.sourceName !== 'audit_log' || !/^\d+$/.test(payload.sourceId)) {
    refuse('I25 recovery requires numeric audit_log source identity');
  }
  const numericSourceId = requirePositiveInteger(payload.sourceId, 'source_id');
  const numericSourcePosition = requirePositiveInteger(sourcePosition, 'source_position');
  if (numericSourceId !== numericSourcePosition) {
    refuse('I25 source position does not match audit_log identity');
  }
  const expectedPartition = `siem:audit_log:security:target:${payload.targetId}`;
  if (sourcePartition !== expectedPartition) {
    refuse('I25 source partition does not match target attempt lineage');
  }
  const expectedDuplicate = `i25:${payload.eventId}:${payload.targetId}:${payload.attemptNumber}:${payload.payloadSha256}`;
  if (duplicateKey !== expectedDuplicate) {
    refuse('I25 duplicate key does not match per-target attempt evidence');
  }
  if (payload.occurredAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I25 occurred_at does not match attempt evidence');
  }

  const candidates = await tx.$queryRawUnsafe(
    `SELECT d.id, d.event_id, d.target_id, d.attempt_number,
            d.payload_sha256::text, d.status, d.acknowledgement_state,
            d.send_authority, d.recovery_inbox_id::text, d.created_at::text,
            e.source_name, e.source_id
       FROM siem_export_delivery_attempts d
       JOIN siem_export_events e
         ON e.tenant_id = d.tenant_id AND e.id = d.event_id
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
      FOR UPDATE OF d`,
    tid,
    payload.attemptId,
  );
  const candidate = candidates[0];
  if (!candidate
      || Number(candidate.event_id) !== payload.eventId
      || Number(candidate.target_id) !== payload.targetId
      || Number(candidate.attempt_number) !== payload.attemptNumber
      || candidate.payload_sha256 !== payload.payloadSha256
      || candidate.source_name !== payload.sourceName
      || candidate.source_id !== payload.sourceId
      || candidate.acknowledgement_state !== payload.acknowledgementState
      || candidate.acknowledgement_state === 'positive'
      || !['failed', 'dead', 'succeeded'].includes(candidate.status)
      || candidate.send_authority !== 'normal'
      || candidate.recovery_inbox_id
      || new Date(candidate.created_at).toISOString() !== payload.occurredAt) {
    refuse('I25 attempt is not eligible for exact owner recovery');
  }

  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE siem_export_delivery_attempts
        SET recovery_inbox_id = $3::uuid,
            recovery_interface_family = 'I25',
            recovery_owner_uid = $4::uuid,
            recovery_owner_reason = $5::text,
            recovery_evidence = $6::jsonb,
            send_authority = 'held_owner_reconciliation',
            effect_disposition = 'late_pending_only'
      WHERE tenant_id = $1::uuid AND id = $2::bigint
        AND status IN ('failed', 'dead', 'succeeded')
        AND acknowledgement_state <> 'positive'
        AND send_authority = 'normal'
        AND recovery_inbox_id IS NULL
      RETURNING id, event_id, target_id, attempt_number, status,
                acknowledgement_state, recovery_inbox_id::text,
                send_authority, effect_disposition`,
    tid,
    payload.attemptId,
    inboxId,
    actorUid,
    ownerReason,
    JSON.stringify({
      ...input.evidence,
      recovery_payload_sha256: rawPayloadHash,
      per_target_attempt_lineage_verified: true,
      shared_export_status_ignored: true,
      transport_completion_is_not_delivery: true,
      late_release_executor_present: false,
      target_delivery_performed: false,
    }),
  );
  const receipt = rows[0];
  if (!receipt) refuse('I25 recovery claim was lost');

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review held SIEM target attempt ${payload.attemptId}`,
    description: 'The exact per-target attempt was bound to owner recovery evidence and held. No SIEM transport or canonical cursor advance was performed.',
    relatedResourceType: 'siem_export_delivery_attempt',
    relatedResourceId: String(payload.attemptId),
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I25',
      recovery_inbox_id: inboxId,
      source_partition: expectedPartition,
      event_id: payload.eventId,
      target_id: payload.targetId,
      attempt_number: payload.attemptNumber,
      target_delivery_performed: false,
      late_release_executor_present: false,
    },
  });

  return Object.freeze({
    receipt: Object.freeze(receipt),
    task,
    outcomeCode: 'i25_siem_attempt_pending_owner_reconciliation',
    recoveryCursorAction: 'pause',
  });
}

export default Object.freeze({
  parseI25SiemRecoveryPayload,
  persistLateSiemAttemptRecovery,
});
