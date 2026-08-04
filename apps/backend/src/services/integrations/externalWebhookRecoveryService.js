import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = new Set([
  'schema',
  'subscription_id',
  'event_outbox_id',
  'event_type',
  'payload_sha256',
  'occurred_at',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I18_WEBHOOK_RECOVERY_INVALID', details = undefined) {
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

function requirePositiveBigInt(value, label) {
  let parsed;
  try {
    parsed = BigInt(String(value));
  } catch {
    refuse(`${label} must be a positive BIGINT`);
  }
  if (parsed < 1n) refuse(`${label} must be a positive BIGINT`);
  return parsed.toString();
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) refuse(`${label} must be a positive integer`);
  return parsed;
}

function requireSha256(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(text)) refuse(`${label} must be lowercase SHA-256`);
  return text;
}

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

export function parseI18WebhookRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I18 webhook recovery payload is invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I18 webhook recovery payload must be an object');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I18 webhook recovery payload fields do not match the registered schema');
  }
  if (payload.schema !== 'vhhealth.i18.webhook-owner-reconciliation/v1') {
    refuse('I18 webhook recovery payload schema is not registered');
  }
  return Object.freeze({
    schema: payload.schema,
    subscriptionId: requirePositiveInteger(payload.subscription_id, 'subscription_id'),
    eventOutboxId: requirePositiveBigInt(payload.event_outbox_id, 'event_outbox_id'),
    eventType: requireText(payload.event_type, 'event_type', 120),
    payloadSha256: requireSha256(payload.payload_sha256, 'payload_sha256'),
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I18 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) {
    refuse('I18 owner recovery command contains unknown fields', undefined, { unexpected });
  }
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I18 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateWebhookRecovery({
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
    throw AppError.internal('I18 recovery requires the canonical recovery transaction', 'I18_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I18',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I18 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const rawPayloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (requireSha256(input.payload_sha256, 'payload_sha256') !== rawPayloadHash) {
    refuse('I18 raw payload hash does not match exact bytes');
  }
  const payload = parseI18WebhookRecoveryPayload(rawPayload);
  if (payload.eventOutboxId !== String(sourcePosition)) {
    refuse('I18 source position must equal event_outbox.id');
  }
  if (payload.occurredAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I18 occurred_at does not match durable source occurrence');
  }
  const expectedPartition = `webhook-subscription:${payload.subscriptionId}:outbound`;
  const expectedDuplicate = `i18:${payload.subscriptionId}:event_outbox:${payload.eventOutboxId}:${payload.payloadSha256}`;
  if (sourcePartition !== expectedPartition) refuse('I18 source partition does not match the subscription');
  if (duplicateKey !== expectedDuplicate) refuse('I18 duplicate key does not match immutable source evidence');

  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const candidates = await tx.$queryRawUnsafe(
    `SELECT delivery.id, delivery.status, delivery.acknowledgement_state,
            delivery.payload_sha256::text, delivery.source_identity,
            delivery.downstream_effect_classification,
            delivery.acknowledgement_contract, source.occurred_at::text
       FROM webhook_deliveries AS delivery
       JOIN event_outbox AS source
         ON source.tenant_id = delivery.tenant_id
        AND source.id = delivery.event_outbox_id
      WHERE delivery.tenant_id = $1::uuid
        AND delivery.subscription_id = $2::integer
        AND delivery.event_outbox_id = $3::bigint
        AND delivery.source_kind = 'event_outbox'
      FOR UPDATE OF delivery`,
    tid,
    payload.subscriptionId,
    payload.eventOutboxId,
  );
  const candidate = candidates[0];
  if (!candidate
      || candidate.payload_sha256 !== payload.payloadSha256
      || candidate.acknowledgement_state === 'positive'
      || candidate.status === 'in_flight'
      || new Date(candidate.occurred_at).toISOString() !== payload.occurredAt) {
    refuse('I18 delivery is not eligible for exact owner recovery');
  }

  const rows = await tx.$queryRawUnsafe(
    `UPDATE webhook_deliveries
        SET send_authority = 'held_owner_reconciliation',
            next_retry_at = NULL,
            recovery_inbox_id = $4::uuid,
            recovery_interface_family = 'I18',
            recovery_owner_uid = $5::uuid,
            recovery_owner_reason = $6::text,
            recovery_evidence = $7::jsonb,
            effect_disposition = 'late_pending_only',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND subscription_id = $2::integer
        AND event_outbox_id = $3::bigint
        AND recovery_inbox_id IS NULL
        AND status <> 'in_flight'
        AND acknowledgement_state <> 'positive'
      RETURNING id, subscription_id, event_outbox_id::text, event_type,
                status, acknowledgement_state, acknowledgement_contract,
                downstream_effect_classification, send_authority,
                recovery_inbox_id::text, effect_disposition, created_at`,
    tid,
    payload.subscriptionId,
    payload.eventOutboxId,
    inboxId,
    actorUid,
    ownerReason,
    JSON.stringify({
      ...input.evidence,
      recovery_payload_sha256: rawPayloadHash,
      source_payload_sha256: payload.payloadSha256,
      exact_payload_fingerprint_verified: true,
      event_outbox_status_is_not_acknowledgement: true,
      http_2xx_is_transport_only: true,
      outbound_dispatch_authorized: false,
      late_release_executor_present: false,
    }),
  );
  const receipt = rows[0];
  if (!receipt) refuse('I18 recovery claim was lost');

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review held subscriber webhook ${payload.eventType}`,
    description: 'The exact webhook occurrence was bound to recovery evidence and held. No subscriber delivery or late release was performed.',
    relatedResourceType: 'webhook_delivery',
    relatedResourceId: String(receipt.id),
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I18',
      recovery_inbox_id: inboxId,
      subscription_id: payload.subscriptionId,
      event_outbox_id: payload.eventOutboxId,
      downstream_effect_classification: candidate.downstream_effect_classification,
      acknowledgement_contract: candidate.acknowledgement_contract,
      http_2xx_is_transport_only: true,
      outbound_dispatch_authorized: false,
      late_release_executor_present: false,
      target_domain_effect_performed: false,
    },
  });

  return Object.freeze({
    receipt: Object.freeze({ ...receipt, id: receipt.id }),
    task,
    outcomeCode: 'i18_webhook_pending_owner_reconciliation',
    recoveryCursorAction: 'pause',
  });
}

export default Object.freeze({
  parseI18WebhookRecoveryPayload,
  persistLateWebhookRecovery,
});
