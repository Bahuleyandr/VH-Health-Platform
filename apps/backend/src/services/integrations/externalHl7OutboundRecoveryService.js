import { AppError } from '../../utils/AppError.js';
import {
  authorizeOwnerRetryTx,
  recordOwnerAcknowledgementTx,
} from '../hl7/hl7OutboundDeliveryLedgerService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['record_acknowledgement', 'authorize_send']);
const COMMAND_KEYS = new Set([
  'action',
  'message_id',
  'raw_acknowledgement',
  'actor_uid',
  'owner_reason',
  'evidence',
]);

function refuse(message, code = 'I04_OUTBOUND_RECONCILIATION_REFUSED', details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireClosedCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('I04 owner reconciliation command must be an object');
  }
  const unexpected = Object.keys(value).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length > 0) {
    refuse('I04 owner reconciliation command contains unknown fields', undefined, { unexpected });
  }
  return value;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) refuse(`${label} must be a UUID`);
  return text;
}

function requireMessageId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) refuse('message_id is invalid');
  return id;
}

function requireAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (!ACTIONS.has(action)) refuse('I04 owner reconciliation action is invalid');
  return action;
}

function requireReason(value) {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 500) refuse('owner_reason is required');
  return reason;
}

function requireEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    refuse('I04 owner evidence must be a non-empty object');
  }
  return value;
}

export async function persistLateHl7OutboundRecovery({
  tx,
  capability,
  tenantId,
  recoveryInboxId,
  command,
} = {}) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal('I04 recovery requires the canonical recovery transaction', 'I04_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I04',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I04 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const action = requireAction(input.action);
  const messageId = requireMessageId(input.message_id);
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireReason(input.owner_reason);
  const evidence = requireEvidence(input.evidence);

  let domain;
  if (action === 'record_acknowledgement') {
    const rawAcknowledgement = String(input.raw_acknowledgement || '');
    if (!rawAcknowledgement.trim()) refuse('raw_acknowledgement is required');
    const reconciled = await recordOwnerAcknowledgementTx(tx, {
      tenantId: tid,
      messageId,
      rawAcknowledgement,
      recoveryInboxId: inboxId,
      actorUid,
      ownerReason,
      evidence,
    });
    domain = Object.freeze({
      ...reconciled,
      acknowledgement: Object.freeze({
        ...reconciled.acknowledgement,
        id: reconciled.acknowledgement.acknowledgement_id,
      }),
    });
  } else {
    if (input.raw_acknowledgement !== null && input.raw_acknowledgement !== undefined) {
      refuse('authorize_send cannot carry acknowledgement evidence');
    }
    const authority = await authorizeOwnerRetryTx(tx, {
      tenantId: tid,
      messageId,
      actorUid,
      ownerReason,
      recoveryInboxId: inboxId,
    });
    domain = Object.freeze({
      authority: Object.freeze({ ...authority, id: String(authority.id) }),
      recoveryCursorAction: 'pause',
    });
  }

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review I04 outbound HL7 ${action.replaceAll('_', ' ')}`,
    description: action === 'record_acknowledgement'
      ? 'Owner evidence reconciled a parsed HL7 MSA acknowledgement. This records downstream state and does not authorize another send.'
      : 'The accountable owner explicitly released one held HL7 message for a future send. No network delivery occurs in the recovery transaction.',
    relatedResourceType: 'hl7_outbound_message',
    relatedResourceId: String(messageId),
    priority: action === 'authorize_send' ? 'high' : 'normal',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I04',
      recovery_inbox_id: inboxId,
      message_id: messageId,
      action,
      transport_result_changed: false,
      acknowledgement_reconciled: action === 'record_acknowledgement',
      send_authority_changed: action === 'authorize_send',
      network_send_performed: false,
      cursor_advance_requires_correlated_msa_aa: true,
    },
  });

  return Object.freeze({
    ...domain,
    task,
    outcomeCode: action === 'record_acknowledgement'
      ? `i04_msa_${domain.parsed.state}`
      : 'i04_owner_send_authorized_ack_pending',
  });
}

export default Object.freeze({ persistLateHl7OutboundRecovery });
