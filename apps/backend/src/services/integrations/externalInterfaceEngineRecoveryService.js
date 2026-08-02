import { createHash } from 'node:crypto';

import { decryptField } from '../../utils/fieldEncryption.js';
import { AppError } from '../../utils/AppError.js';
import { requireI05ProtocolAdapter } from '../interfaceEngine/protocolAdapters/index.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEYS = new Set(['message_id', 'actor_uid', 'owner_reason', 'evidence']);

function refuse(message, code = 'I05_RECOVERY_REFUSED', details = undefined) {
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

function requireMessageId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) refuse('message_id is invalid');
  return id;
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I05 owner reconciliation command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) refuse('I05 owner reconciliation command contains unknown fields', undefined, { unexpected });
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I05 owner evidence must be a non-empty object');
  }
  return command;
}

function expectedPartition(message, streamDirection) {
  return `channel:${message.channel_id}:${streamDirection}:target:${message.target_system_id || 'backend'}`;
}

function expectedDuplicateKey(message, streamDirection) {
  return `${message.protocol}:${message.channel_id}:${streamDirection}:${message.target_system_id || 'backend'}:${message.payload_hash}`;
}

export async function persistLateInterfaceEngineRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  protocol,
  streamDirection,
  sourcePartition,
  sourcePosition,
  sourceToken,
  predecessorToken,
  duplicateKey,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I05 recovery requires the canonical recovery transaction', 'I05_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I05',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I05 recovery capability inbox does not match');
  const protocolAdapter = requireI05ProtocolAdapter(protocol);

  const input = requireClosedCommand(command);
  const messageId = requireMessageId(input.message_id);
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const direction = String(streamDirection || '').trim().toLowerCase();
  if (!['inbound', 'outbound'].includes(direction)) refuse('stream_direction is invalid');

  const rows = await tx.$queryRawUnsafe(
    `SELECT message.id, message.tenant_id::text AS tenant_id, message.channel_id,
            message.channel_version_id, message.direction, message.protocol,
            message.external_control_id, message.payload_hash,
            message.raw_payload_ciphertext, message.status,
            message.recovery_ledger_version, channel.target_system_id
       FROM interop_messages AS message
       JOIN interop_channels AS channel
         ON channel.tenant_id = message.tenant_id
        AND channel.id = message.channel_id
      WHERE message.tenant_id = $1::uuid AND message.id = $2::integer
      FOR UPDATE OF message`,
    tid,
    messageId,
  );
  const message = rows[0];
  if (!message) refuse('I05 message was not found', 'I05_MESSAGE_NOT_FOUND');
  if (message.protocol !== protocol) refuse('I05 message protocol does not match the recovery adapter');
  if (message.direction !== direction && message.direction !== 'bidirectional') {
    refuse('I05 message direction does not match the recovery stream');
  }
  if (message.recovery_ledger_version !== 0) refuse('I05 message is already recovery-enrolled');
  if (['delivered', 'replayed'].includes(message.status)) {
    refuse('I05 delivered messages cannot be enrolled as late work');
  }
  if (!message.raw_payload_ciphertext) refuse('I05 retained payload is required for recovery parity');
  if (sourcePartition !== expectedPartition(message, direction)) {
    refuse('I05 source partition does not match tenant/channel/direction/target');
  }
  if (duplicateKey !== expectedDuplicateKey(message, direction)) {
    refuse('I05 duplicate key does not match protocol and payload evidence');
  }

  const rawPayload = decryptField(message.raw_payload_ciphertext);
  protocolAdapter.assertMessageParity(message, rawPayload);
  const rawHash = createHash('sha256').update(Buffer.from(rawPayload, 'utf8')).digest('hex');

  const enrolled = await tx.$queryRawUnsafe(
    `UPDATE interop_messages
        SET recovery_ledger_version = 1,
            source_position = $3::bigint,
            source_token = $4::text,
            predecessor_token = $5::text,
            recovery_inbox_id = $6::uuid,
            recovery_interface_family = 'I05',
            arrival_class = 'recovery_backlog',
            effect_disposition = 'late_pending_only',
            send_authority = 'held',
            owner_reconciliation_required = true,
            status = 'quarantined',
            last_error_code = 'INTEROP_LATE_PENDING_REVIEW',
            last_error_safe = 'Late interface message is held for owner review',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND recovery_ledger_version = 0
      RETURNING id, protocol, direction, status, recovery_ledger_version,
                source_position::text, source_token, predecessor_token,
                recovery_inbox_id::text, effect_disposition, send_authority`,
    tid,
    messageId,
    sourcePosition,
    sourceToken,
    predecessorToken,
    inboxId,
  );
  if (!enrolled[0]) refuse('I05 recovery enrollment fence was lost');

  const receiptStatus = direction === 'inbound' ? 'pending_review' : 'send_held';
  const adapterKey = direction === 'inbound'
    ? protocolAdapter.backendAdapterKeys[0]
    : protocolAdapter.externalAdapterKey;
  const receipts = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, recovery_inbox_id, owner_actor_uid,
        recovery_interface_family, owner_reason, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
             $6::text, $7::text, $8::text, $9::char(64), $10::integer,
             '{}'::jsonb, $11::text, $12::uuid, $13::uuid, 'I05', $14::text, $15::jsonb)
     RETURNING id::text, message_id, direction, adapter_key, adapter_version,
               payload_sha256::text, payload_bytes, receipt_status,
               recovery_inbox_id::text, created_at`,
    tid,
    message.id,
    message.channel_id,
    message.channel_version_id,
    protocol,
    direction,
    adapterKey,
    protocolAdapter.adapterVersion,
    rawHash,
    Buffer.byteLength(rawPayload, 'utf8'),
    receiptStatus,
    inboxId,
    actorUid,
    ownerReason,
    JSON.stringify({
      ...input.evidence,
      protocol_adapter: protocol,
      byte_parity_verified: true,
      target_domain_effect_performed: false,
      network_send_performed: false,
    }),
  );

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review late I05 ${protocol.toUpperCase()} ${direction} message`,
    description: direction === 'inbound'
      ? `The original ${protocol.toUpperCase()} bytes were verified and retained as pending integration review. No backend clinical adapter effect was performed.`
      : `The original ${protocol.toUpperCase()} bytes were verified and the outbound message remains held. No external send was authorized or performed.`,
    relatedResourceType: 'interop_message',
    relatedResourceId: String(message.id),
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I05',
      protocol,
      direction,
      recovery_inbox_id: inboxId,
      message_id: message.id,
      receipt_id: receipts[0].id,
      byte_parity_verified: true,
      target_domain_effect_performed: false,
      network_send_performed: false,
    },
  });

  return Object.freeze({
    message: enrolled[0],
    receipt: Object.freeze({ ...receipts[0], id: receipts[0].id }),
    task,
    outcomeCode: direction === 'inbound'
      ? `i05_${protocol}_inbound_pending_review`
      : `i05_${protocol}_outbound_send_held`,
  });
}

export default Object.freeze({ persistLateInterfaceEngineRecovery });
