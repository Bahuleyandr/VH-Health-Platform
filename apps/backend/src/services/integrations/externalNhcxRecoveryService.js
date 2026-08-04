import { createHash, randomUUID } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';
import { requireExternalRecoveryCapability } from './externalRecoveryEffectGate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ENVIRONMENTS = new Set(['sandbox', 'production']);
const OUTBOUND_DISPOSITIONS = new Set([
  'investigate',
  'manual_redrive_requested',
  'cancel_requested',
]);
const INBOUND_DISPOSITIONS = new Set([
  'investigate',
  'manual_retry_requested',
  'cancel_requested',
]);
const PAYLOAD_KEYS = new Set([
  'schema',
  'nhcx_message_id',
  'direction',
  'environment',
  'endpoint',
  'occurred_at',
  'hcx_api_call_id',
  'payload_hash',
  'payload_ciphertext_base64',
  'payload_ciphertext_sha256',
]);
const COMMAND_KEYS = new Set([
  'raw_payload',
  'payload_sha256',
  'actor_uid',
  'owner_reason',
  'owner_disposition',
  'evidence',
]);

function refuse(message, code = 'I19_NHCX_RECOVERY_INVALID', details) {
  throw AppError.badRequest(message, code, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) refuse(`${label} must be a UUID`);
  return normalized;
}

function requireText(value, label, max) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) refuse(`${label} is invalid`);
  return normalized;
}

function requireSha256(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256_RE.test(normalized)) refuse(`${label} must be lowercase SHA-256`);
  return normalized;
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

function requireTimestamp(value, label) {
  const parsed = new Date(String(value || ''));
  if (Number.isNaN(parsed.getTime())) refuse(`${label} must be a timestamp`);
  return parsed.toISOString();
}

function decodeCanonicalBase64(value) {
  const encoded = requireText(value, 'payload_ciphertext_base64', 4_000_000);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded) {
    refuse('payload_ciphertext_base64 must be canonical non-empty base64');
  }
  return decoded;
}

export function parseI19NhcxOutboundRecoveryPayload(value) {
  let payload;
  try {
    payload = JSON.parse(String(value ?? ''));
  } catch {
    refuse('I19 NHCX recovery payload is invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('I19 NHCX recovery payload must be an object');
  }
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.size || keys.some(key => !PAYLOAD_KEYS.has(key))) {
    refuse('I19 NHCX recovery payload fields do not match the registered schema');
  }
  if (payload.schema !== 'vhhealth.i19.nhcx-outbound-owner-reconciliation/v1') {
    refuse('I19 NHCX recovery payload schema is not registered');
  }
  if (payload.direction !== 'outbound') {
    refuse('I19 inbound callback replay is blocked without a provider transport sequence');
  }
  const environment = String(payload.environment || '').trim().toLowerCase();
  if (!ENVIRONMENTS.has(environment)) refuse('I19 NHCX environment is invalid');
  const ciphertext = decodeCanonicalBase64(payload.payload_ciphertext_base64);
  const ciphertextHash = requireSha256(
    payload.payload_ciphertext_sha256,
    'payload_ciphertext_sha256',
  );
  if (sha256(ciphertext) !== ciphertextHash) {
    refuse('I19 NHCX ciphertext hash does not match exact bytes');
  }
  return Object.freeze({
    schema: payload.schema,
    messageId: requirePositiveBigInt(payload.nhcx_message_id, 'nhcx_message_id'),
    direction: 'outbound',
    environment,
    endpoint: requireText(payload.endpoint, 'endpoint', 120),
    occurredAt: requireTimestamp(payload.occurred_at, 'occurred_at'),
    hcxApiCallId: requireText(payload.hcx_api_call_id, 'hcx_api_call_id', 120),
    payloadHash: requireSha256(payload.payload_hash, 'payload_hash'),
    ciphertext,
    ciphertextSha256: ciphertextHash,
  });
}

function requireClosedCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    refuse('I19 owner recovery command must be an object');
  }
  const unexpected = Object.keys(command).filter(key => !COMMAND_KEYS.has(key));
  if (unexpected.length) {
    refuse('I19 owner recovery command contains unknown fields', undefined, { unexpected });
  }
  if (!command.evidence || typeof command.evidence !== 'object'
      || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) {
    refuse('I19 owner evidence must be a non-empty object');
  }
  return command;
}

export async function persistLateNhcxRecovery({
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
    throw AppError.internal('I19 recovery requires the canonical recovery transaction', 'I19_RECOVERY_TX_REQUIRED');
  }
  const tid = requireTenantId(tenantId);
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  requireExternalRecoveryCapability(capability, {
    tenantId: tid,
    facilityId: null,
    interfaceFamily: 'I19',
    effectDisposition: 'late_pending_only',
  });
  if (capability.inboxId !== inboxId) refuse('I19 recovery capability inbox does not match');

  const input = requireClosedCommand(command);
  const rawPayload = String(input.raw_payload || '');
  if (!rawPayload) refuse('raw_payload is required');
  const rawPayloadHash = sha256(Buffer.from(rawPayload, 'utf8'));
  if (requireSha256(input.payload_sha256, 'payload_sha256') !== rawPayloadHash) {
    refuse('I19 raw payload hash does not match exact bytes');
  }
  const payload = parseI19NhcxOutboundRecoveryPayload(rawPayload);
  if (payload.messageId !== String(sourcePosition)) {
    refuse('I19 source position must equal the local nhcx_messages.id');
  }
  if (payload.occurredAt !== requireTimestamp(occurredAt, 'occurred_at')) {
    refuse('I19 occurred_at does not match durable source occurrence');
  }
  const expectedPartition = `nhcx:${payload.environment}:outbound:${payload.endpoint}`;
  const expectedDuplicate = `i19:outbound:${payload.hcxApiCallId}`;
  if (sourcePartition !== expectedPartition) {
    refuse('I19 source partition does not match environment, direction, and endpoint');
  }
  if (duplicateKey !== expectedDuplicate) {
    refuse('I19 duplicate key must be the outbound HCX API-call identity');
  }
  const actorUid = requireUuid(input.actor_uid, 'actor_uid');
  const ownerReason = requireText(input.owner_reason, 'owner_reason', 500);
  const ownerDisposition = String(input.owner_disposition || '').trim().toLowerCase();
  if (!OUTBOUND_DISPOSITIONS.has(ownerDisposition)) {
    refuse('I19 outbound owner disposition is invalid');
  }

  const existingRows = await tx.$queryRawUnsafe(
    `SELECT id::text, tenant_id::text, environment, direction, cycle, endpoint,
            hcx_api_call_id, hcx_correlation_id, hcx_workflow_id, payload_hash,
            payload_ciphertext, status, created_at::text, recovery_inbox_id::text
       FROM nhcx_messages
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      FOR UPDATE`,
    tid,
    payload.messageId,
  );
  const existing = existingRows[0];
  if (!existing
      || existing.direction !== 'outbound'
      || existing.cycle === 'payment_notice'
      || existing.environment !== payload.environment
      || existing.endpoint !== payload.endpoint
      || existing.hcx_api_call_id !== payload.hcxApiCallId
      || existing.payload_hash !== payload.payloadHash
      || existing.recovery_inbox_id !== null
      || !['sent', 'failed', 'dead', 'rejected'].includes(existing.status)
      || new Date(existing.created_at).toISOString() !== payload.occurredAt) {
    refuse('I19 outbound message is not eligible for exact owner recovery');
  }
  const storedCiphertext = Buffer.from(String(existing.payload_ciphertext || ''), 'utf8');
  if (storedCiphertext.length === 0 || !storedCiphertext.equals(payload.ciphertext)) {
    refuse('I19 recovery ciphertext does not match the stored outbound occurrence');
  }

  const rows = await tx.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = 'recovery_pending', next_retry_at = NULL,
            recovery_inbox_id = $3::uuid,
            recovery_interface_family = 'I19',
            recovery_owner_uid = $4::uuid,
            recovery_owner_reason = $5::text,
            recovery_disposition = $6::text,
            recovery_claimed_at = NOW(),
            recovery_prior_status = status,
            recovery_evidence = $7::jsonb,
            source_partition = $8::text,
            source_position = $9::bigint,
            source_token = $10::text,
            predecessor_token = $11::text,
            duplicate_key = $12::text,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
        AND recovery_inbox_id IS NULL
        AND status IN ('sent', 'failed', 'dead', 'rejected')
      RETURNING id::text, environment, direction, cycle, endpoint,
                hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
                payload_hash, status, recovery_prior_status,
                recovery_inbox_id::text, recovery_disposition,
                recovery_claimed_at, recovery_evidence`,
    tid,
    payload.messageId,
    inboxId,
    actorUid,
    ownerReason,
    ownerDisposition,
    JSON.stringify({
      ...input.evidence,
      recovery_payload_sha256: rawPayloadHash,
      ciphertext_sha256: payload.ciphertextSha256,
      exact_ciphertext_byte_parity_verified: true,
      source_position_is_local_nhcx_message_id: true,
      provider_sequence_present_inbound: false,
      inbound_replay_authorized: false,
      outbound_dispatch_authorized: false,
      payment_notice_manual_only: true,
    }),
    sourcePartition,
    sourcePosition,
    sourceToken,
    predecessorToken,
    duplicateKey,
  );
  const receipt = rows[0];
  if (!receipt) refuse('I19 outbound recovery claim was lost');

  const task = await createTask({
    tenantId: tid,
    taskKind: 'review',
    title: `Review held NHCX ${existing.cycle} message`,
    description: 'The exact outbound ciphertext was frozen for owner reconciliation. No NHCX dispatch, redrive, authorization mutation, or payment action was performed.',
    relatedResourceType: 'nhcx_message',
    relatedResourceId: payload.messageId,
    priority: 'high',
    assignedToRole: 'TENANT_ADMIN',
    createdBy: actorUid,
    slaCompletionSemantics: 'none',
    tx,
    metadata: {
      contract: 'late_pending_only',
      interface_family: 'I19',
      recovery_inbox_id: inboxId,
      nhcx_message_id: payload.messageId,
      environment: payload.environment,
      endpoint: payload.endpoint,
      hcx_api_call_id: payload.hcxApiCallId,
      owner_disposition: ownerDisposition,
      exact_ciphertext_byte_parity_verified: true,
      source_position_is_local_nhcx_message_id: true,
      provider_sequence_present_inbound: false,
      inbound_replay_authorized: false,
      outbound_dispatch_authorized: false,
      payment_notice_manual_only: true,
      target_domain_effect_performed: false,
    },
  });

  return Object.freeze({
    receipt: Object.freeze({ ...receipt, id: receipt.id }),
    task,
    outcomeCode: 'i19_outbound_message_pending_owner_reconciliation',
    recoveryCursorAction: 'pause',
  });
}

export async function claimStrandedInboundNHCXMessage({
  tenantId,
  messageId,
  actorUid,
  ownerReason,
  ownerDisposition = 'investigate',
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = requirePositiveBigInt(messageId, 'nhcx_message_id');
  const actor = requireUuid(actorUid, 'actor_uid');
  const reason = requireText(ownerReason, 'owner_reason', 500);
  const disposition = String(ownerDisposition || '').trim().toLowerCase();
  if (!INBOUND_DISPOSITIONS.has(disposition)) {
    refuse('I19 inbound owner disposition is invalid');
  }

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE nhcx_messages
          SET status = 'recovery_pending',
              inbound_claim_token = COALESCE(inbound_claim_token, $4::uuid),
              inbound_claimed_at = COALESCE(inbound_claimed_at, created_at),
              inbound_owner_uid = $5::uuid,
              inbound_owner_reason = $6::text,
              inbound_owner_disposition = $7::text,
              inbound_owner_claimed_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
          AND direction = 'inbound' AND cycle <> 'payment_notice'
          AND (
            (status = 'processing' AND inbound_claimed_at <= NOW() - ($3::integer * INTERVAL '1 minute'))
            OR (status = 'accepted' AND created_at <= NOW() - ($3::integer * INTERVAL '1 minute'))
          )
          AND inbound_owner_uid IS NULL
        RETURNING id::text, environment, direction, cycle, endpoint,
                  hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
                  payload_hash, status, inbound_claim_token::text,
                  inbound_claimed_at, inbound_owner_uid::text,
                  inbound_owner_disposition, inbound_owner_claimed_at`,
      tid,
      id,
      5,
      randomUUID(),
      actor,
      reason,
      disposition,
    );
    const message = rows[0];
    if (!message) {
      throw AppError.conflict(
        'NHCX inbound callback is not a stale claimable processing envelope',
        'I19_NHCX_INBOUND_NOT_CLAIMABLE',
      );
    }
    const task = await createTask({
      tenantId: tid,
      taskKind: 'review',
      title: `Review stranded NHCX ${message.cycle} callback`,
      description: 'The inbound callback was frozen after its durable processing claim. Provider sequence is absent, so no callback replay or domain retry was started.',
      relatedResourceType: 'nhcx_message',
      relatedResourceId: id,
      priority: 'high',
      assignedToRole: 'TENANT_ADMIN',
      createdBy: actor,
      slaCompletionSemantics: 'none',
      tx,
      metadata: {
        contract: 'owner_claimed_no_replay',
        interface_family: 'I19',
        nhcx_message_id: id,
        hcx_api_call_id: message.hcx_api_call_id,
        hcx_correlation_id: message.hcx_correlation_id,
        hcx_workflow_id: message.hcx_workflow_id,
        owner_disposition: disposition,
        provider_sequence_present: false,
        correlation_and_workflow_are_identity_not_cursor: true,
        inbound_replay_authorized: false,
        payment_notice_manual_only: true,
        target_domain_effect_performed: false,
      },
    });
    return Object.freeze({ message: Object.freeze(message), task });
  }, { isolationLevel: 'Serializable' });
}

export default Object.freeze({
  parseI19NhcxOutboundRecoveryPayload,
  persistLateNhcxRecovery,
  claimStrandedInboundNHCXMessage,
});
