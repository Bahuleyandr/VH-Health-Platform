import { AppError } from '../../utils/AppError.js';
import {
  applyProviderReceiptToCursorTx,
  recordProviderReceiptTx,
} from '../notification/notificationDeliveryLedgerService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print']);
const OUTCOMES = new Set(['acknowledged', 'rejected', 'uncertain']);
const COMMAND_KEYS = new Set([
  'attempt_id',
  'notification_outbox_id',
  'channel',
  'outcome',
  'provider_reference',
  'provider_code',
  'evidence',
  'actor_uid',
  'owner_reason',
]);

function refuse(message, code = 'I17_NOTIFICATION_RECONCILIATION_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireClosedCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('I17 owner reconciliation command must be an object');
  }
  const unexpected = Object.keys(value).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length > 0) {
    refuse('I17 owner reconciliation command contains unknown fields', undefined, { unexpected });
  }
  return value;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireOutboxId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) refuse('notification_outbox_id is invalid');
  return id;
}

function requireChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  if (!CHANNELS.has(channel)) refuse('I17 channel is invalid');
  return channel;
}

function requireOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  if (!OUTCOMES.has(outcome)) refuse('I17 owner outcome is invalid');
  return outcome;
}

function optionalText(value, label, max) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > max) refuse(`${label} is invalid`);
  return text;
}

function requireEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('I17 evidence must be a non-empty object');
  }
  if (Object.keys(value).length === 0) refuse('I17 evidence must be a non-empty object');
  return value;
}

export async function persistLateNotificationRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I17 recovery requires the canonical recovery transaction', 'I17_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I17',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I17 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const attemptId = requireUuid(input.attempt_id, 'attempt_id');
  const outboxId = requireOutboxId(input.notification_outbox_id);
  const channel = requireChannel(input.channel);
  const outcome = requireOutcome(input.outcome);
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = optionalText(input.owner_reason, 'owner_reason', 500);
  const providerReference = optionalText(input.provider_reference, 'provider_reference', 255);
  const providerCode = optionalText(input.provider_code, 'provider_code', 120);
  const evidence = requireEvidence(input.evidence);
  if (!ownerReason) refuse('owner_reason is required');
  if (outcome === 'acknowledged' && !providerReference) {
    refuse('acknowledged owner reconciliation requires provider_reference');
  }

  const attempts = await tx.$queryRawUnsafe(
    `SELECT attempt.attempt_id::text, attempt.notification_outbox_id,
            attempt.channel, attempt.provider, prior.outcome AS prior_outcome,
            prior.receipt_id::text AS prior_receipt_id
       FROM notification_delivery_attempts AS attempt
       JOIN LATERAL (
         SELECT receipt_id, outcome
           FROM notification_provider_receipts
          WHERE tenant_id = attempt.tenant_id AND attempt_id = attempt.attempt_id
            AND receipt_source <> 'owner_reconciliation'
          ORDER BY observed_at DESC LIMIT 1
       ) AS prior ON TRUE
      WHERE attempt.tenant_id = $1::uuid AND attempt.attempt_id = $2::uuid
        AND attempt.notification_outbox_id = $3::integer
        AND attempt.channel = $4::text
        AND prior.outcome IN ('rejected', 'uncertain')
      FOR UPDATE OF attempt`,
    tid, attemptId, outboxId, channel,
  );
  if (attempts.length !== 1) {
    refuse('I17 owner reconciliation requires an existing rejected or uncertain provider attempt');
  }

  const receipt = await recordProviderReceiptTx(tx, {
    tenantId: tid,
    attemptId,
    outboxId,
    channel,
    outcome,
    receiptSource: 'owner_reconciliation',
    providerReference,
    providerCode,
    evidence: {
      ...evidence,
      prior_receipt_id: attempts[0].prior_receipt_id,
      prior_outcome: attempts[0].prior_outcome,
    },
    recoveryInboxId: inboxId,
    ownerActorUid: actorUid,
    ownerReason,
  });

  const cursor = await applyProviderReceiptToCursorTx(tx, {
    tenantId: tid,
    receiptId: receipt.receipt_id,
  });
  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review I17 ${channel} provider reconciliation`,
    description: 'Provider state was reconciled from owner-directed evidence. This records delivery state only and does not authorize a send or retrospective notification.',
    relatedResourceType: 'notification_outbox',
    relatedResourceId: String(outboxId),
    priority: outcome === 'acknowledged' ? 'normal' : 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I17',
      recovery_inbox_id: inboxId,
      attempt_id: attemptId,
      receipt_id: receipt.receipt_id,
      provider_outcome: outcome,
      permission_to_send_changed: false,
      retrospective_send_authorized: false,
      owner_reconciliation_required: true,
    },
  });

  return Object.freeze({
    receipt: Object.freeze({ ...receipt, id: receipt.receipt_id }),
    cursor,
    task,
    outcomeCode: `i17_provider_${outcome}`,
    recoveryCursorAction: outcome === 'acknowledged' ? 'advance' : 'pause',
  });
}

export default Object.freeze({ persistLateNotificationRecovery });
