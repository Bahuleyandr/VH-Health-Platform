import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  OPERATOR_REPLAY_SUPERSEDED_REASON,
  TERMINAL_REJECTION_CODES,
  isTerminalRejectionCode,
} from '../../utils/notifications/terminalRejectionCodes.js';
import { requireTenantId } from '../tenant/tenantService.js';

const CHANNELS = new Set(['push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print']);
const OUTCOMES = new Set(['acknowledged', 'rejected', 'uncertain']);
const RECEIPT_SOURCES = new Set([
  'provider_response',
  'transport_failure',
  'lease_expiry',
  'owner_reconciliation',
  'operator_reconciliation',
]);

const PROVIDERS = Object.freeze({
  push: 'firebase_fcm',
  email: 'smtp',
  inapp: 'local_database',
  whatsapp: 'twilio_whatsapp',
  voice: 'twilio_voice',
  sms: 'sms_gateway',
  print: 'print_queue',
});

function normalizeChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  if (!CHANNELS.has(channel)) {
    throw AppError.badRequest('notification channel is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return channel;
}

function normalizeOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  if (!OUTCOMES.has(outcome)) {
    throw AppError.badRequest('provider outcome is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return outcome;
}

function normalizeReceiptSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (!RECEIPT_SOURCES.has(source)) {
    throw AppError.badRequest('provider receipt source is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return source;
}

function normalizeOutboxId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw AppError.badRequest('notification_outbox_id is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return id;
}

function normalizeGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw AppError.badRequest('claim_generation is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return generation;
}

function normalizeEvidence(value) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('provider evidence must be an object', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return value;
}

async function loadClaimTx(tx, { tenantId, outboxId, claimToken, claimGeneration }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, channel, status, claim_token::text,
            claim_generation, rendered_intent_hash
       FROM notification_outbox
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'CLAIMED' AND claim_token = $3::uuid
        AND claim_generation = $4::integer
      FOR UPDATE`,
    tenantId, outboxId, claimToken, claimGeneration,
  );
  if (rows.length !== 1) {
    throw AppError.conflict('Notification claim fence was lost', 'NOTIFICATION_CLAIM_FENCE_LOST');
  }
  return rows[0];
}

async function ensureCursorTx(tx, tenantId, channel) {
  await tx.$executeRawUnsafe(
    `INSERT INTO notification_delivery_cursors (tenant_id, channel)
     VALUES ($1::uuid, $2::text)
     ON CONFLICT (tenant_id, channel) DO NOTHING`,
    tenantId, channel,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id::text, channel, last_contiguous_outbox_id,
            state, blocked_outbox_id, inflight_outbox_id
       FROM notification_delivery_cursors
      WHERE tenant_id = $1::uuid AND channel = $2::text
      FOR UPDATE`,
    tenantId, channel,
  );
  return rows[0];
}

async function beginProviderAttemptTx(tx, {
  tenantId,
  outboxId,
  claimToken,
  claimGeneration,
  renderedIntentHash,
  channel,
  provider = null,
}) {
  const normalizedChannel = normalizeChannel(channel);
  const claim = await loadClaimTx(tx, { tenantId, outboxId, claimToken, claimGeneration });
  if (claim.rendered_intent_hash !== renderedIntentHash) {
    throw AppError.conflict('Rendered notification intent changed after claim', 'NOTIFICATION_INTENT_FENCE_LOST');
  }

  const accepted = await tx.$queryRawUnsafe(
    `SELECT receipt.receipt_id::text, receipt.outcome
       FROM notification_provider_receipts AS receipt
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.notification_outbox_id = $2::integer
        AND receipt.channel = $3::text
        AND receipt.outcome = 'acknowledged'
      ORDER BY receipt.observed_at DESC
      LIMIT 1`,
    tenantId, outboxId, normalizedChannel,
  );
  if (accepted.length === 1) {
    return Object.freeze({ channel: normalizedChannel, state: 'acknowledged', receiptId: accepted[0].receipt_id });
  }

  const cursor = await ensureCursorTx(tx, tenantId, normalizedChannel);
  if (cursor.state === 'paused_rejected' || cursor.state === 'paused_uncertain') {
    return Object.freeze({
      channel: normalizedChannel,
      state: 'blocked',
      reason: cursor.state,
      blockedOutboxId: cursor.blocked_outbox_id,
    });
  }
  if (cursor.state === 'delivering' && Number(cursor.inflight_outbox_id) !== outboxId) {
    return Object.freeze({
      channel: normalizedChannel,
      state: 'blocked',
      reason: 'earlier_delivery_inflight',
      blockedOutboxId: cursor.blocked_outbox_id,
    });
  }

  // "Resolved" for ordering = acknowledged OR terminally rejected for its one
  // recipient OR operator-superseded. Keep in sync with the identical
  // predicates in notificationOutbox.claimPendingBatch and the acknowledged
  // cursor-advance gap check below (fix R3).
  const earlier = await tx.$queryRawUnsafe(
    `SELECT id
       FROM notification_outbox
      WHERE tenant_id = $1::uuid AND channel = $2::text
        AND ledger_version = 1 AND id < $3::integer
        AND status NOT IN ('SENT', 'SUPPRESSED')
        AND NOT (status = 'RECONCILIATION_REQUIRED' AND failure_reason = $5::text)
        AND NOT EXISTS (
          SELECT 1 FROM notification_provider_receipts AS resolved
           WHERE resolved.tenant_id = notification_outbox.tenant_id
             AND resolved.notification_outbox_id = notification_outbox.id
             AND resolved.channel = $2::text
             AND (resolved.outcome = 'acknowledged'
               OR (resolved.outcome = 'rejected'
                 AND resolved.provider_code = ANY($4::text[])))
        )
      ORDER BY id
      LIMIT 1`,
    tenantId, normalizedChannel, outboxId,
    TERMINAL_REJECTION_CODES, OPERATOR_REPLAY_SUPERSEDED_REASON,
  );
  if (earlier.length === 1) {
    return Object.freeze({
      channel: normalizedChannel,
      state: 'blocked',
      reason: 'earlier_delivery_not_terminal',
      blockedOutboxId: earlier[0].id,
    });
  }

  await tx.$executeRawUnsafe(
    `UPDATE notification_delivery_cursors
        SET state = 'delivering', blocked_outbox_id = $3::integer,
            inflight_outbox_id = $3::integer, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND channel = $2::text`,
    tenantId, normalizedChannel, outboxId,
  );

  const attempts = await tx.$queryRawUnsafe(
    `INSERT INTO notification_delivery_attempts
       (tenant_id, notification_outbox_id, channel, claim_token,
        claim_generation, attempt_number, provider, rendered_intent_hash)
     SELECT $1::uuid, $2::integer, $3::text, $4::uuid, $5::integer,
            COALESCE(MAX(attempt_number), 0) + 1, $6::text, $7::char(64)
       FROM notification_delivery_attempts
      WHERE tenant_id = $1::uuid
        AND notification_outbox_id = $2::integer AND channel = $3::text
     ON CONFLICT (tenant_id, notification_outbox_id, channel, claim_token)
     DO NOTHING
     RETURNING attempt_id::text, notification_outbox_id, channel,
               claim_generation, attempt_number, provider, rendered_intent_hash, started_at`,
    tenantId, outboxId, normalizedChannel, claimToken, claimGeneration,
    provider || PROVIDERS[normalizedChannel], renderedIntentHash,
  );
  if (attempts.length === 1) return Object.freeze({ ...attempts[0], state: 'ready' });
  const existing = await tx.$queryRawUnsafe(
    `SELECT attempt_id::text, notification_outbox_id, channel,
            claim_generation, attempt_number, provider, rendered_intent_hash, started_at
       FROM notification_delivery_attempts
      WHERE tenant_id = $1::uuid AND notification_outbox_id = $2::integer
        AND channel = $3::text AND claim_token = $4::uuid`,
    tenantId, outboxId, normalizedChannel, claimToken,
  );
  return Object.freeze({ ...existing[0], state: 'ready', duplicate: true });
}

export async function beginProviderAttempts({
  tenantId,
  outboxId,
  claimToken,
  claimGeneration,
  renderedIntentHash,
  channels,
} = {}) {
  const tid = requireTenantId(tenantId);
  const oid = normalizeOutboxId(outboxId);
  const generation = normalizeGeneration(claimGeneration);
  const normalizedChannels = [...new Set((channels || []).map(normalizeChannel))];
  if (normalizedChannels.length === 0) {
    throw AppError.badRequest('at least one notification channel is required', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return setTenantTx(tid, async (tx) => {
    const attempts = [];
    for (const channel of normalizedChannels) {
      attempts.push(await beginProviderAttemptTx(tx, {
        tenantId: tid,
        outboxId: oid,
        claimToken,
        claimGeneration: generation,
        renderedIntentHash,
        channel,
      }));
    }
    return attempts;
  }, { isolationLevel: 'Serializable' });
}

export async function recordProviderReceiptTx(tx, {
  tenantId,
  attemptId,
  outboxId,
  channel,
  outcome,
  receiptSource,
  providerReference = null,
  providerCode = null,
  evidence = {},
  recoveryInboxId = null,
  ownerActorUid = null,
  ownerReason = null,
} = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedOutcome = normalizeOutcome(outcome);
  const normalizedSource = normalizeReceiptSource(receiptSource);
  const oid = normalizeOutboxId(outboxId);
  if (normalizedOutcome === 'acknowledged' && !String(providerReference || '').trim()) {
    throw AppError.badRequest('acknowledged provider receipt requires a reference', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  if (normalizedSource === 'owner_reconciliation'
    && (!recoveryInboxId || !ownerActorUid || !String(ownerReason || '').trim())) {
    throw AppError.badRequest('owner reconciliation provenance is incomplete', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  if (normalizedSource === 'operator_reconciliation'
    && (!ownerActorUid || !String(ownerReason || '').trim())) {
    throw AppError.badRequest('operator reconciliation provenance is incomplete', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO notification_provider_receipts
       (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
        receipt_source, provider_reference, provider_code, evidence,
        recovery_inbox_id, recovery_interface_family, owner_actor_uid, owner_reason)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::text, $5::text,
             $6::text, $7::text, $8::text, $9::jsonb,
             $10::uuid, CASE WHEN $10::uuid IS NULL THEN NULL ELSE 'I17' END,
             $11::uuid, $12::text)
     ON CONFLICT (
       attempt_id,
       receipt_source,
       (COALESCE(recovery_inbox_id, '00000000-0000-0000-0000-000000000000'::uuid))
     ) DO NOTHING
     RETURNING receipt_id::text, tenant_id::text, attempt_id::text,
               notification_outbox_id, channel, outcome, receipt_source,
               provider_reference, provider_code, evidence, observed_at,
               recovery_inbox_id::text, owner_actor_uid::text, owner_reason`,
    tenantId, attemptId, oid, normalizedChannel, normalizedOutcome,
    normalizedSource, providerReference, providerCode,
    JSON.stringify(normalizeEvidence(evidence)), recoveryInboxId, ownerActorUid, ownerReason,
  );
  if (rows.length === 1) return rows[0];
  const existing = await tx.$queryRawUnsafe(
    `SELECT receipt_id::text, tenant_id::text, attempt_id::text,
            notification_outbox_id, channel, outcome, receipt_source,
            provider_reference, provider_code, evidence, observed_at,
            recovery_inbox_id::text, owner_actor_uid::text, owner_reason
       FROM notification_provider_receipts
      WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid
        AND receipt_source = $3::text
        AND COALESCE(recovery_inbox_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    tenantId, attemptId, normalizedSource, recoveryInboxId,
  );
  return existing[0];
}

export async function recordProviderReceipt(input = {}) {
  const tid = requireTenantId(input.tenantId);
  return setTenantTx(tid, tx => recordProviderReceiptTx(tx, { ...input, tenantId: tid }));
}

export async function applyProviderReceiptToCursorTx(tx, {
  tenantId,
  receiptId,
} = {}) {
  const receipts = await tx.$queryRawUnsafe(
    `SELECT receipt_id::text, notification_outbox_id, channel, outcome, provider_code
       FROM notification_provider_receipts
      WHERE tenant_id = $1::uuid AND receipt_id = $2::uuid`,
    tenantId, receiptId,
  );
  if (receipts.length !== 1) {
    throw AppError.notFound('Provider receipt was not found', 'NOTIFICATION_PROVIDER_RECEIPT_NOT_FOUND');
  }
  const receipt = receipts[0];
  const cursor = await ensureCursorTx(tx, tenantId, receipt.channel);
  const outboxId = Number(receipt.notification_outbox_id);

  if (cursor.last_contiguous_outbox_id !== null
    && Number(cursor.last_contiguous_outbox_id) >= outboxId) {
    return Object.freeze({ ...cursor, duplicate: true });
  }
  const ownsInflight = cursor.state === 'delivering'
    && Number(cursor.inflight_outbox_id) === outboxId
    && Number(cursor.blocked_outbox_id) === outboxId;
  const ownsPausedHead = receipt.outcome === 'acknowledged'
    && ['paused_rejected', 'paused_uncertain'].includes(cursor.state)
    && cursor.inflight_outbox_id === null
    && Number(cursor.blocked_outbox_id) === outboxId;
  if (!ownsInflight && !ownsPausedHead) {
    return Object.freeze({ ...cursor, stale: true });
  }

  if (receipt.outcome === 'acknowledged') {
    // Same resolved-for-ordering predicate as beginProviderAttemptTx /
    // claimPendingBatch: a terminally-rejected or operator-superseded earlier
    // row is not a gap — the cursor may advance PAST it (the DB trigger only
    // requires an acknowledged receipt on the row the cursor lands ON).
    const earlier = await tx.$queryRawUnsafe(
      `SELECT id
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND channel = $2::text
          AND ledger_version = 1 AND id < $3::integer
          AND status NOT IN ('SENT', 'SUPPRESSED')
          AND NOT (status = 'RECONCILIATION_REQUIRED' AND failure_reason = $5::text)
          AND NOT EXISTS (
            SELECT 1 FROM notification_provider_receipts AS resolved
             WHERE resolved.tenant_id = notification_outbox.tenant_id
               AND resolved.notification_outbox_id = notification_outbox.id
               AND resolved.channel = $2::text
               AND (resolved.outcome = 'acknowledged'
                 OR (resolved.outcome = 'rejected'
                   AND resolved.provider_code = ANY($4::text[])))
          )
        ORDER BY id LIMIT 1`,
      tenantId, receipt.channel, outboxId,
      TERMINAL_REJECTION_CODES, OPERATOR_REPLAY_SUPERSEDED_REASON,
    );
    if (earlier.length === 1) {
      throw AppError.conflict(
        'Notification delivery cursor cannot skip an unresolved intent',
        'NOTIFICATION_DELIVERY_CURSOR_GAP',
      );
    }
    const advanced = await tx.$queryRawUnsafe(
      `UPDATE notification_delivery_cursors
          SET last_contiguous_outbox_id = $3::integer, state = 'ready',
              blocked_outbox_id = NULL, inflight_outbox_id = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND channel = $2::text
          AND (last_contiguous_outbox_id IS NULL OR last_contiguous_outbox_id < $3::integer)
          AND (
            (state = 'delivering'
              AND inflight_outbox_id = $3::integer
              AND blocked_outbox_id = $3::integer)
            OR
            (state IN ('paused_rejected', 'paused_uncertain')
              AND inflight_outbox_id IS NULL
              AND blocked_outbox_id = $3::integer)
          )
        RETURNING tenant_id::text, channel, last_contiguous_outbox_id,
                  state, blocked_outbox_id, inflight_outbox_id, updated_at`,
      tenantId, receipt.channel, outboxId,
    );
    return advanced[0] || Object.freeze({ ...cursor, duplicate: true });
  }

  // R3: a TERMINAL per-recipient rejection (missing/unregistered token, no
  // phone/email, recipient not found) must not wedge the whole channel. The
  // rejection receipt stands as evidence, the row dead-letters through the
  // normal FAILED path, and the cursor resumes 'ready' so later rows deliver.
  // last_contiguous_outbox_id is deliberately NOT advanced onto the rejected
  // row — the mig-609 trigger (chk_notification_delivery_cursor_positive_receipt)
  // reserves that column for acknowledged rows; the resolved-for-ordering
  // predicates above let a later acknowledgement advance past this row.
  if (receipt.outcome === 'rejected' && isTerminalRejectionCode(receipt.provider_code)) {
    const resumed = await tx.$queryRawUnsafe(
      `UPDATE notification_delivery_cursors
          SET state = 'ready', blocked_outbox_id = NULL,
              inflight_outbox_id = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND channel = $2::text
          AND state = 'delivering'
          AND inflight_outbox_id = $3::integer
          AND blocked_outbox_id = $3::integer
        RETURNING tenant_id::text, channel, last_contiguous_outbox_id,
                  state, blocked_outbox_id, inflight_outbox_id, updated_at`,
      tenantId, receipt.channel, outboxId,
    );
    return Object.freeze({
      ...resumed[0],
      skipped_outbox_id: outboxId,
      terminal_rejection_code: receipt.provider_code,
    });
  }

  const pausedState = receipt.outcome === 'uncertain' ? 'paused_uncertain' : 'paused_rejected';
  const paused = await tx.$queryRawUnsafe(
    `UPDATE notification_delivery_cursors
        SET state = $3::text, blocked_outbox_id = $4::integer,
            inflight_outbox_id = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND channel = $2::text
        AND state = 'delivering'
        AND inflight_outbox_id = $4::integer
        AND blocked_outbox_id = $4::integer
      RETURNING tenant_id::text, channel, last_contiguous_outbox_id,
                state, blocked_outbox_id, inflight_outbox_id, updated_at`,
    tenantId, receipt.channel, pausedState, outboxId,
  );
  return paused[0];
}

export async function applyProviderReceiptToCursor({ tenantId, receiptId } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, tx => applyProviderReceiptToCursorTx(tx, { tenantId: tid, receiptId }), {
    isolationLevel: 'Serializable',
  });
}

export async function reconcileExpiredClaims({ tenantId, limit = 50 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
  return setTenantTx(tid, async (tx) => {
    const expired = await tx.$queryRawUnsafe(
      `SELECT id, claim_token::text, claim_generation, channel
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND status = 'CLAIMED'
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at, id
        LIMIT $2::integer FOR UPDATE SKIP LOCKED`,
      tid, safeLimit,
    );
    let reset = 0;
    let reconciled = 0;
    for (const row of expired) {
      const attempts = await tx.$queryRawUnsafe(
        `SELECT attempt.attempt_id::text, attempt.channel,
                receipt.receipt_id::text, receipt.outcome, receipt.provider_code
           FROM notification_delivery_attempts AS attempt
           LEFT JOIN LATERAL (
              SELECT receipt_id, outcome, provider_code
               FROM notification_provider_receipts
              WHERE tenant_id = attempt.tenant_id AND attempt_id = attempt.attempt_id
              ORDER BY observed_at DESC LIMIT 1
           ) AS receipt ON TRUE
          WHERE attempt.tenant_id = $1::uuid
            AND attempt.notification_outbox_id = $2::integer
            AND attempt.claim_token = $3::uuid`,
        tid, row.id, row.claim_token,
      );
      if (attempts.length === 0) {
        await tx.$executeRawUnsafe(
          `UPDATE notification_outbox
              SET status = 'PENDING', claim_token = NULL, claimed_at = NULL,
                  lease_expires_at = NULL, failure_reason = 'claim_expired_before_provider_attempt'
            WHERE tenant_id = $1::uuid AND id = $2::integer
              AND status = 'CLAIMED' AND claim_token = $3::uuid`,
          tid, row.id, row.claim_token,
        );
        reset += 1;
        continue;
      }

      for (const attempt of attempts) {
        let receiptId = attempt.receipt_id;
        if (!receiptId) {
          const receipt = await recordProviderReceiptTx(tx, {
            tenantId: tid,
            attemptId: attempt.attempt_id,
            outboxId: row.id,
            channel: attempt.channel,
            outcome: 'uncertain',
            receiptSource: 'lease_expiry',
            providerCode: 'worker_lease_expired_after_attempt_started',
            evidence: { claim_token: row.claim_token, claim_generation: Number(row.claim_generation) },
          });
          receiptId = receipt.receipt_id;
          attempt.receipt_id = receipt.receipt_id;
          attempt.outcome = receipt.outcome;
          attempt.provider_code = receipt.provider_code;
        }
        await applyProviderReceiptToCursorTx(tx, { tenantId: tid, receiptId });
      }
      const allAcknowledged = attempts.every(attempt => attempt.outcome === 'acknowledged');
      const allResolved = attempts.every(attempt => Boolean(attempt.receipt_id));
      const hasTerminalRejection = attempts.some(attempt => (
        attempt.outcome === 'rejected' && isTerminalRejectionCode(attempt.provider_code)
      ));
      const terminallyResolved = allResolved
        && hasTerminalRejection
        && attempts.every(attempt => (
          attempt.outcome === 'acknowledged'
          || (attempt.outcome === 'rejected' && isTerminalRejectionCode(attempt.provider_code))
        ));
      const finalStatus = allAcknowledged ? 'SENT'
        : terminallyResolved ? 'FAILED'
          : 'RECONCILIATION_REQUIRED';
      await tx.$executeRawUnsafe(
        `UPDATE notification_outbox
            SET status = $4::text, claim_token = NULL, claimed_at = NULL,
                lease_expires_at = NULL, last_attempt_at = NOW(),
                sent_at = CASE WHEN $4::text = 'SENT' THEN NOW() ELSE sent_at END,
                retry_count = CASE WHEN $4::text = 'FAILED'
                  THEN GREATEST(retry_count, 3) ELSE retry_count END,
                failure_reason = CASE WHEN $4::text = 'SENT' THEN NULL
                  WHEN $4::text = 'FAILED' THEN 'provider_terminal_rejection'
                  ELSE 'provider_state_requires_owner_reconciliation' END
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'CLAIMED' AND claim_token = $3::uuid`,
        tid, row.id, row.claim_token, finalStatus,
      );
      reconciled += 1;
    }
    return Object.freeze({ expired: expired.length, reset, reconciled });
  }, { isolationLevel: 'Serializable' });
}

export function providerForChannel(channel) {
  return PROVIDERS[normalizeChannel(channel)];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireOperatorProvenance({ reason, actorUid, actorRole }) {
  const operatorReason = String(reason || '').trim();
  if (!operatorReason || operatorReason.length > 1000) {
    throw AppError.badRequest('reason is required (max 1000 chars)', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  const uid = String(actorUid || '').trim().toLowerCase();
  if (!UUID_RE.test(uid)) {
    throw AppError.badRequest('actor uid is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  const role = String(actorRole || '').trim();
  if (!role || role.length > 50) {
    throw AppError.badRequest('actor role is invalid', 'NOTIFICATION_DELIVERY_INPUT_INVALID');
  }
  return { operatorReason, uid, role };
}

/** Operator visibility over the per-tenant/channel delivery cursors. */
export async function listChannelCursors({ tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, tx => tx.$queryRawUnsafe(
    `SELECT tenant_id::text, channel, last_contiguous_outbox_id, state,
            blocked_outbox_id, inflight_outbox_id, updated_at
       FROM notification_delivery_cursors
      WHERE tenant_id = $1::uuid
      ORDER BY channel`,
    tid,
  ));
}

/**
 * Operator reset for a stale cursor whose head row is already terminally
 * resolved. An unresolved head must be replayed/reconciled through the typed
 * outbox operation first; merely clearing the cursor would report success
 * while claimPendingBatch continued to block on that row.
 */
export async function resetChannelCursor({
  tenantId,
  channel,
  reason,
  actorUid,
  actorRole,
  requestId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedChannel = normalizeChannel(channel);
  const { operatorReason, uid, role } = requireOperatorProvenance({ reason, actorUid, actorRole });
  return setTenantTx(tid, async (tx) => {
    const current = await tx.$queryRawUnsafe(
      `SELECT tenant_id::text, channel, last_contiguous_outbox_id, state,
              blocked_outbox_id, inflight_outbox_id
         FROM notification_delivery_cursors
        WHERE tenant_id = $1::uuid AND channel = $2::text
        FOR UPDATE`,
      tid, normalizedChannel,
    );
    if (current.length !== 1) {
      throw AppError.notFound('Notification delivery cursor was not found', 'NOTIFICATION_DELIVERY_CURSOR_NOT_FOUND');
    }
    if (!['paused_rejected', 'paused_uncertain'].includes(current[0].state)) {
      throw AppError.conflict('Notification delivery cursor is not paused', 'NOTIFICATION_DELIVERY_CURSOR_NOT_PAUSED');
    }
    if (!current[0].blocked_outbox_id) {
      throw AppError.conflict(
        'Notification delivery cursor has no resolved head to reset',
        'NOTIFICATION_DELIVERY_HEAD_UNRESOLVED',
      );
    }
    const blocked = await tx.$queryRawUnsafe(
      `SELECT outbox.id, outbox.status, outbox.failure_reason,
              (
                outbox.status IN ('SENT', 'SUPPRESSED')
                OR (outbox.status = 'RECONCILIATION_REQUIRED'
                  AND outbox.failure_reason = $4::text)
                OR EXISTS (
                  SELECT 1
                    FROM notification_provider_receipts AS receipt
                   WHERE receipt.tenant_id = outbox.tenant_id
                     AND receipt.notification_outbox_id = outbox.id
                     AND receipt.channel = outbox.channel
                     AND (receipt.outcome = 'acknowledged'
                       OR (receipt.outcome = 'rejected'
                         AND receipt.provider_code = ANY($3::text[])))
                )
              ) AS ledger_resolved
         FROM notification_outbox AS outbox
        WHERE outbox.tenant_id = $1::uuid AND outbox.id = $2::integer
          AND outbox.channel = $5::text
        FOR UPDATE OF outbox`,
      tid,
      Number(current[0].blocked_outbox_id),
      TERMINAL_REJECTION_CODES,
      OPERATOR_REPLAY_SUPERSEDED_REASON,
      normalizedChannel,
    );
    if (blocked.length !== 1 || blocked[0].ledger_resolved !== true) {
      throw AppError.conflict(
        'Resolve or replay the blocked notification before resetting its channel cursor',
        'NOTIFICATION_DELIVERY_HEAD_UNRESOLVED',
        {
          blocked_outbox_id: current[0].blocked_outbox_id,
          blocked_status: blocked[0]?.status || null,
        },
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE notification_delivery_cursors
          SET state = 'ready', blocked_outbox_id = NULL,
              inflight_outbox_id = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND channel = $2::text
          AND state IN ('paused_rejected', 'paused_uncertain')
        RETURNING tenant_id::text, channel, last_contiguous_outbox_id,
                  state, blocked_outbox_id, inflight_outbox_id, updated_at`,
      tid, normalizedChannel,
    );
    await tx.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'NOTIFICATION_CHANNEL_CURSOR_RESET',
               'notification_delivery_cursors', $4::text, $5::jsonb, NOW())`,
      tid, uid, role, normalizedChannel,
      JSON.stringify({
        reason: operatorReason,
        request_id: requestId ? String(requestId).slice(0, 180) : null,
        prior_state: current[0].state,
        prior_blocked_outbox_id: current[0].blocked_outbox_id,
        prior_inflight_outbox_id: current[0].inflight_outbox_id,
      }),
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });
}

export const __testing__ = Object.freeze({
  normalizeChannel,
  normalizeOutcome,
  normalizeReceiptSource,
  normalizeEvidence,
});

export const notificationDeliveryLedgerService = Object.freeze({
  beginProviderAttempts,
  recordProviderReceipt,
  applyProviderReceiptToCursor,
  reconcileExpiredClaims,
  providerForChannel,
  listChannelCursors,
  resetChannelCursor,
});

export default notificationDeliveryLedgerService;
