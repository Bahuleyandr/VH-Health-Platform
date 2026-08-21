// src/services/notification/notificationOutboxAdminService.js
//
// Operator surface over notification_outbox dead letters (F7/F11 + R3, audit
// 2026-08-10). Mirrors eventOutboxService.listEvents / redriveFailedEvent:
// tenant-scoped setTenantTx, FOR UPDATE state fence, audit_logs provenance
// row, recordOutboxOperatorRedrive metric.
//
// The mig-609 transition guard (chk_notification_outbox_state_transition)
// forbids FAILED -> PENDING and any transition OUT of
// RECONCILIATION_REQUIRED, so replay works WITH the state machine instead of
// against it:
//   * FAILED           -> reset retry_count/last_attempt_at in place (status
//                         untouched — both columns are mutable); the drain's
//                         claim window (status FAILED, retry_count < 3) picks
//                         the row straight back up.
//   * RECONCILIATION_REQUIRED -> the provider state of the ORIGINAL send is
//                         unknowable, so the row itself is never re-sent.
//                         The operator (named actor + recorded reason,
//                         explicitly accepting duplicate-delivery risk)
//                         queues a NEW outbox intent with a
//                         `:operator-replay:` source-event-key suffix, and
//                         the original row is stamped
//                         failure_reason='operator_replay_superseded' so the
//                         strict per-channel ordering predicates stop
//                         treating it as an unresolved gap. If the channel
//                         cursor is paused ON this row, it is resumed in the
//                         same transaction.
import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  recordNotificationOutboxAutoReplay,
  recordOutboxOperatorRedrive,
} from '../../observability/reliabilityMetrics.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY } from '../../utils/notifications/tenantNotificationChannels.js';
import {
  AUTO_REPLAY_EXHAUSTED_REASON,
  AUTO_REPLAYABLE_RECONCILIATION_REASONS,
  NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS,
  OPERATOR_REPLAY_SUPERSEDED_REASON,
} from '../../utils/notifications/terminalRejectionCodes.js';
import {
  applyProviderReceiptToCursorTx,
  recordProviderReceiptTx,
} from './notificationDeliveryLedgerService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const STATUSES = Object.freeze([
  'PENDING', 'CLAIMED', 'SENT', 'FAILED', 'RECONCILIATION_REQUIRED', 'SUPPRESSED',
]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SOURCE_EVENT_KEY_LENGTH = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_OUTBOX_ROW_SELECT = `SELECT notification_outbox.id,
       notification_outbox.type, notification_outbox.channel,
       notification_outbox.status, notification_outbox.recipient_id,
       notification_outbox.recipient_phone, notification_outbox.title,
       notification_outbox.source_event_key, notification_outbox.recipient_key,
       notification_outbox.template_version, notification_outbox.retry_count,
       notification_outbox.failure_reason, notification_outbox.created_at,
       notification_outbox.last_attempt_at, notification_outbox.sent_at,
       notification_outbox.lease_expires_at,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'attempt_id', attempt.attempt_id::text,
           'channel', attempt.channel,
           'provider', attempt.provider,
           'attempt_number', attempt.attempt_number,
           'started_at', attempt.started_at,
           'receipt_id', receipt.receipt_id::text,
           'outcome', receipt.outcome,
           'receipt_source', receipt.receipt_source,
           'provider_reference', receipt.provider_reference,
           'provider_code', receipt.provider_code,
           'evidence', receipt.evidence,
           'observed_at', receipt.observed_at,
           'owner_actor_uid', receipt.owner_actor_uid::text,
           'owner_reason', receipt.owner_reason
         ) ORDER BY attempt.started_at DESC)
           FROM notification_delivery_attempts AS attempt
           LEFT JOIN LATERAL (
             SELECT receipt_id, outcome, receipt_source, provider_reference,
                    provider_code, evidence, observed_at, owner_actor_uid,
                    owner_reason
               FROM notification_provider_receipts
              WHERE tenant_id = attempt.tenant_id
                AND attempt_id = attempt.attempt_id
              ORDER BY observed_at DESC, receipt_id DESC
              LIMIT 1
           ) AS receipt ON TRUE
          WHERE attempt.tenant_id = notification_outbox.tenant_id
            AND attempt.notification_outbox_id = notification_outbox.id
            AND attempt.attempt_number = (
              SELECT MAX(newest.attempt_number)
                FROM notification_delivery_attempts AS newest
               WHERE newest.tenant_id = attempt.tenant_id
                 AND newest.notification_outbox_id = attempt.notification_outbox_id
                 AND newest.channel = attempt.channel
            )
       ), '[]'::jsonb) AS delivery_attempts,
       (notification_outbox.status = 'RECONCILIATION_REQUIRED'
         OR (notification_outbox.status = 'FAILED'
           AND notification_outbox.retry_count >= 3)) AS dead_letter`;

function mapNotificationOutboxRow(row) {
  if (!row) return null;
  return {
    ...row,
    retry_count: Number(row.retry_count),
    delivery_attempts: Array.isArray(row.delivery_attempts) ? row.delivery_attempts : [],
    dead_letter: Boolean(row.dead_letter),
  };
}

function replaySourceEventKey(originalValue, sourceMarker, outboxId) {
  const originalKey = String(originalValue);
  const marker = String(sourceMarker);
  const id = String(outboxId);
  const digest = createHash('sha256')
    .update(originalKey)
    .update('\0')
    .update(marker)
    .update('\0')
    .update(id)
    .digest('hex');
  const suffix = `${marker}:${id}:${digest}`;
  const prefixLength = MAX_SOURCE_EVENT_KEY_LENGTH - suffix.length - 1;
  if (prefixLength < 0) {
    throw AppError.internal('Notification outbox replay identity exceeds its storage bound');
  }

  // Pick a separator that differs from the truncated original at the cut
  // point. This makes the replacement distinct by construction even for a
  // deliberately chosen 255-character source key, while the digest keeps the
  // bounded form collision-resistant and deterministic across retries.
  const separator = originalKey.length > prefixLength && originalKey[prefixLength] === ':'
    ? '~'
    : ':';
  const replacementKey = `${originalKey.slice(0, prefixLength)}${separator}${suffix}`;
  if (replacementKey === originalKey) {
    throw AppError.internal('Notification outbox replay key did not produce a distinct identity');
  }
  return replacementKey;
}

function replayChainStartedAtMs(row) {
  const inherited = Number(row.payload?.[REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY]);
  if (Number(row.replay_generation ?? 0) > 0) {
    if (Number.isSafeInteger(inherited) && inherited > 0) return inherited;
    throw AppError.internal('Notification outbox replay chain has no valid root start time');
  }
  const createdAt = new Date(row.created_at).getTime();
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw AppError.internal('Notification outbox replay row has no valid chain start time');
  }
  return createdAt;
}

async function latestDeliveryAttemptsTx(tx, tenantId, outboxId) {
  return tx.$queryRawUnsafe(
    `SELECT attempt.channel, receipt.outcome
       FROM notification_delivery_attempts AS attempt
       LEFT JOIN LATERAL (
         SELECT outcome
           FROM notification_provider_receipts
          WHERE tenant_id = attempt.tenant_id
            AND notification_outbox_id = attempt.notification_outbox_id
            AND channel = attempt.channel
            AND (attempt_id = attempt.attempt_id OR outcome = 'acknowledged')
          ORDER BY (outcome = 'acknowledged') DESC,
                   observed_at DESC, receipt_id DESC
          LIMIT 1
       ) AS receipt ON TRUE
      WHERE attempt.tenant_id = $1::uuid
        AND attempt.notification_outbox_id = $2::integer
        AND attempt.attempt_number = (
          SELECT MAX(newest.attempt_number)
            FROM notification_delivery_attempts AS newest
           WHERE newest.tenant_id = attempt.tenant_id
             AND newest.notification_outbox_id = attempt.notification_outbox_id
             AND newest.channel = attempt.channel
        )
      ORDER BY attempt.channel
      FOR UPDATE OF attempt`,
    tenantId, outboxId,
  );
}

async function pausedDeliveryCursorsTx(tx, tenantId, outboxId) {
  return tx.$queryRawUnsafe(
    `SELECT channel, state
       FROM notification_delivery_cursors
      WHERE tenant_id = $1::uuid
        AND blocked_outbox_id = $2::integer
        AND state IN ('paused_rejected', 'paused_uncertain')
      ORDER BY channel
      FOR UPDATE`,
    tenantId, outboxId,
  );
}

async function resetFailedReplayCursorsTx(tx, tenantId, row) {
  const latestAttempts = await latestDeliveryAttemptsTx(tx, tenantId, row.id);
  const pausedCursors = await pausedDeliveryCursorsTx(tx, tenantId, row.id);
  const outcomes = new Map(
    latestAttempts.map(attempt => [String(attempt.channel), attempt.outcome]),
  );
  const ambiguousChannels = latestAttempts
    .filter(attempt => !['acknowledged', 'rejected'].includes(attempt.outcome))
    .map(attempt => String(attempt.channel));
  const unsafePausedChannels = pausedCursors
    .filter(cursor => cursor.state !== 'paused_rejected'
      || outcomes.get(String(cursor.channel)) !== 'rejected')
    .map(cursor => String(cursor.channel));
  if (ambiguousChannels.length > 0 || unsafePausedChannels.length > 0) {
    throw AppError.conflict(
      'Notification outbox FAILED replay has ambiguous delivery state',
      'NOTIFICATION_OUTBOX_REPLAY_CHANNEL_AMBIGUOUS',
      { channels: [...new Set([...ambiguousChannels, ...unsafePausedChannels])] },
    );
  }

  const acknowledgedChannels = new Set(
    latestAttempts
      .filter(attempt => attempt.outcome === 'acknowledged')
      .map(attempt => String(attempt.channel)),
  );
  const replayChannels = latestAttempts
    .filter(attempt => attempt.outcome === 'rejected')
    .map(attempt => String(attempt.channel))
    .filter(channel => !acknowledgedChannels.has(channel));
  if (replayChannels.length === 0 && latestAttempts.length === 0) {
    replayChannels.push(String(row.channel));
  }
  if (replayChannels.length === 0) {
    throw AppError.conflict(
      'Notification outbox FAILED row has no rejected delivery channel to replay',
      'NOTIFICATION_OUTBOX_REPLAY_CHANNEL_RESOLVED',
    );
  }

  const resumedChannels = pausedCursors.map(cursor => String(cursor.channel));
  if (resumedChannels.length > 0) {
    const reset = await tx.$queryRawUnsafe(
      `UPDATE notification_delivery_cursors
          SET state = 'ready', blocked_outbox_id = NULL,
              inflight_outbox_id = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND channel = ANY($2::text[])
          AND state = 'paused_rejected'
          AND blocked_outbox_id = $3::integer
        RETURNING channel`,
      tenantId, resumedChannels, row.id,
    );
    if (reset.length !== resumedChannels.length) {
      throw AppError.conflict(
        'Notification outbox replay lost its delivery cursor fence',
        'NOTIFICATION_OUTBOX_REPLAY_CURSOR_FENCE_LOST',
      );
    }
  }
  return { replayChannels, resumedChannels };
}

async function readNotificationOutboxRowTx(tx, tenantId, id) {
  const rows = await tx.$queryRawUnsafe(
    `${NOTIFICATION_OUTBOX_ROW_SELECT}
       FROM notification_outbox
      WHERE notification_outbox.tenant_id = $1::uuid
        AND notification_outbox.id = $2::integer
      LIMIT 1`,
    tenantId,
    id,
  );
  return mapNotificationOutboxRow(rows[0]);
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw AppError.badRequest(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeOutboxId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw AppError.badRequest('notification outbox id is invalid');
  }
  return id;
}

function normalizeAttemptId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) throw AppError.badRequest('delivery attempt id is invalid');
  return id;
}

function requiredText(value, max, label) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw AppError.badRequest(`${label} is required (max ${max} chars)`);
  return text;
}

function requireEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw AppError.badRequest('provider evidence must be a non-empty object');
  }
  return value;
}

function requireOperator({ reason, actorUid, actorRole }) {
  const operatorReason = String(reason || '').trim();
  if (!operatorReason || operatorReason.length > 1000) {
    throw AppError.badRequest('reason is required (max 1000 chars)');
  }
  const uid = String(actorUid || '').trim().toLowerCase();
  if (!UUID_RE.test(uid)) throw AppError.badRequest('actor uid is invalid');
  const role = String(actorRole || '').trim();
  if (!role || role.length > 50) throw AppError.badRequest('actor role is invalid');
  return { operatorReason, uid, role };
}

/** Tenant-scoped listing by status (default FAILED — the retriable-or-dead set). */
export async function listNotificationOutboxRows({
  tenantId,
  status = 'FAILED',
  limit = DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedStatus = String(status || '').trim().toUpperCase();
  if (!STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const safeLimit = boundedInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const safeOffset = boundedInteger(offset, 0, 0, 10_000, 'offset');
  const rows = await setTenantTx(tid, tx => tx.$queryRawUnsafe(
    `${NOTIFICATION_OUTBOX_ROW_SELECT}
       FROM notification_outbox
      WHERE notification_outbox.tenant_id = $1::uuid
        AND notification_outbox.status = $2::text
      ORDER BY notification_outbox.id ASC
      LIMIT $3::integer OFFSET $4::integer`,
    tid, normalizedStatus, safeLimit, safeOffset,
  ));
  return rows.map(mapNotificationOutboxRow);
}

/** Record externally verified provider acceptance for one unresolved attempt. */
export async function reconcileNotificationOutboxAttempt({
  tenantId,
  id,
  attemptId,
  providerReference,
  evidence,
  reason,
  actorUid,
  actorRole,
  requestId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const outboxId = normalizeOutboxId(id);
  const deliveryAttemptId = normalizeAttemptId(attemptId);
  const reference = requiredText(providerReference, 255, 'provider reference');
  const providerEvidence = requireEvidence(evidence);
  const { operatorReason, uid, role } = requireOperator({ reason, actorUid, actorRole });
  if (operatorReason.length > 500) {
    throw AppError.badRequest('provider reconciliation reason is too long (max 500 chars)');
  }
  const request = requestId ? String(requestId).slice(0, 180) : null;

  return setTenantTx(tid, async (tx) => {
    const current = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tid, outboxId,
    );
    if (!current[0]) throw AppError.notFound('Notification outbox row not found');
    if (current[0].status !== 'RECONCILIATION_REQUIRED') {
      throw AppError.conflict('Notification outbox row does not require reconciliation');
    }

    const attempts = await tx.$queryRawUnsafe(
      `SELECT attempt.attempt_id::text, attempt.channel, attempt.provider,
              receipt.receipt_id::text, receipt.outcome, receipt.provider_code
         FROM notification_delivery_attempts AS attempt
         LEFT JOIN LATERAL (
           SELECT receipt_id, outcome, provider_code
             FROM notification_provider_receipts
            WHERE tenant_id = attempt.tenant_id AND attempt_id = attempt.attempt_id
            ORDER BY observed_at DESC, receipt_id DESC
            LIMIT 1
         ) AS receipt ON TRUE
        WHERE attempt.tenant_id = $1::uuid
          AND attempt.notification_outbox_id = $2::integer
          AND attempt.attempt_number = (
            SELECT MAX(newest.attempt_number)
              FROM notification_delivery_attempts AS newest
             WHERE newest.tenant_id = attempt.tenant_id
               AND newest.notification_outbox_id = attempt.notification_outbox_id
               AND newest.channel = attempt.channel
          )
        ORDER BY attempt.channel
        FOR UPDATE OF attempt`,
      tid, outboxId,
    );
    const target = attempts.find(attempt => attempt.attempt_id === deliveryAttemptId);
    if (!target) throw AppError.notFound('Current delivery attempt not found');
    if (!['uncertain', 'rejected'].includes(target.outcome)) {
      throw AppError.conflict('Delivery attempt is not awaiting reconciliation evidence');
    }

    const receipt = await recordProviderReceiptTx(tx, {
      tenantId: tid,
      attemptId: deliveryAttemptId,
      outboxId,
      channel: target.channel,
      outcome: 'acknowledged',
      receiptSource: 'operator_reconciliation',
      providerReference: reference,
      providerCode: 'operator_verified_acceptance',
      evidence: providerEvidence,
      ownerActorUid: uid,
      ownerReason: operatorReason,
    });
    const cursor = await applyProviderReceiptToCursorTx(tx, {
      tenantId: tid,
      receiptId: receipt.receipt_id,
    });

    target.outcome = 'acknowledged';
    target.receipt_id = receipt.receipt_id;
    const fullyReconciled = attempts.length > 0
      && attempts.every(attempt => attempt.outcome === 'acknowledged');
    if (fullyReconciled) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE notification_outbox
            SET status = 'SENT', sent_at = COALESCE(sent_at, $3::timestamptz),
                failure_reason = NULL, claim_token = NULL, claimed_at = NULL,
                lease_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'RECONCILIATION_REQUIRED'
          RETURNING id, status, sent_at, failure_reason`,
        tid, outboxId, receipt.observed_at,
      );
      if (updated.length !== 1) throw AppError.conflict('Notification reconciliation lost its state fence');
    }

    await tx.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text,
               'NOTIFICATION_OUTBOX_PROVIDER_ACCEPTANCE_RECORDED',
               'notification_outbox', $4::text, $5::jsonb, NOW())`,
      tid, uid, role, String(outboxId),
      JSON.stringify({
        reason: operatorReason,
        request_id: request,
        attempt_id: deliveryAttemptId,
        channel: target.channel,
        provider: target.provider,
        receipt_id: receipt.receipt_id,
        provider_reference: reference,
        fully_reconciled: fullyReconciled,
      }),
    );
    const row = await readNotificationOutboxRowTx(tx, tid, outboxId);
    if (!row) throw AppError.conflict('Notification reconciliation row could not be reloaded');
    return { row, receipt, cursor, fully_reconciled: fullyReconciled };
  }, { isolationLevel: 'Serializable' });
}

/**
 * Requeue a RECONCILIATION_REQUIRED row as a NEW outbox intent inside an open
 * tenant transaction. Shared by the operator replay endpoint and the
 * auto-replay sweep. The provider state of each unresolved channel on the
 * ORIGINAL send is unknowable (mig-609 contract), so acknowledged channels
 * are excluded and only unresolved channels are routed onto the replacement:
 *   1. queue a new intent whose source_event_key carries a
 *      `:<marker>:<originalId>` suffix (dedup-idempotent per original row via
 *      ux_notification_outbox_delivery_intent) and replay_generation + 1;
 *   2. stamp the original failure_reason = OPERATOR_REPLAY_SUPERSEDED_REASON
 *      (exact string — four ordering predicates hardcode it);
 *   3. resume every channel cursor actually paused ON the original row.
 * Returns the replacement id, updated original, and replay/resumed channels.
 */
async function requeueSupersededIntentTx(tx, tid, row, { sourceMarker }) {
  const latestAttempts = await latestDeliveryAttemptsTx(tx, tid, row.id);
  const pausedCursors = await pausedDeliveryCursorsTx(tx, tid, row.id);
  const acknowledgedChannels = new Set(
    latestAttempts
      .filter(attempt => attempt.outcome === 'acknowledged')
      .map(attempt => String(attempt.channel)),
  );
  const replayChannels = [...new Set([
    ...pausedCursors.map(cursor => String(cursor.channel)),
    ...latestAttempts
      .filter(attempt => attempt.outcome !== 'acknowledged')
      .map(attempt => String(attempt.channel)),
  ])].filter(channel => !acknowledgedChannels.has(channel));
  if (replayChannels.length === 0 && latestAttempts.length === 0) {
    replayChannels.push(String(row.channel));
  }
  if (replayChannels.length === 0) {
    throw AppError.conflict('Notification outbox row has no unresolved delivery channel');
  }

  const replacementKey = replaySourceEventKey(row.source_event_key, sourceMarker, row.id);
  const data = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const replacement = await notificationOutbox.queue({
    type: row.type,
    channel: replayChannels[0],
    deliveryChannels: replayChannels,
    recipientId: row.recipient_id,
    recipientPhone: row.recipient_phone,
    tenantId: tid,
    title: row.title,
    body: row.body,
    templateVersion: row.template_version,
    sourceEventKey: replacementKey,
    data: {
      ...data,
      [REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY]: replayChainStartedAtMs(row),
    },
  }, { tx, strict: true, replayGeneration: Number(row.replay_generation ?? 0) + 1 });
  const replacementId = replacement?.id ?? null;
  if (replacementId === null
    || replacement?.duplicate === true
    || String(replacementId) === String(row.id)) {
    throw AppError.conflict(
      'Notification outbox replay did not create a distinct replacement',
      'NOTIFICATION_OUTBOX_REPLAY_REPLACEMENT_COLLISION',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE notification_outbox
        SET failure_reason = $3::text
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'RECONCILIATION_REQUIRED'
      RETURNING id, status, retry_count, failure_reason`,
    tid, row.id, OPERATOR_REPLAY_SUPERSEDED_REASON,
  );
  if (rows.length !== 1) throw AppError.conflict('Notification outbox replay lost its state fence');
  // Resume the cursor rows that actually point at this original. row.channel
  // is only the intent's primary ordering lane and can differ from a failed
  // channel selected by tenant fan-out.
  await tx.$executeRawUnsafe(
    `UPDATE notification_delivery_cursors
        SET state = 'ready', blocked_outbox_id = NULL,
            inflight_outbox_id = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND state IN ('paused_rejected', 'paused_uncertain')
        AND blocked_outbox_id = $2::integer`,
    tid, row.id,
  );
  return {
    replacementId,
    replayChannels,
    resumedChannels: pausedCursors.map(cursor => String(cursor.channel)),
    updated: rows[0],
  };
}

/**
 * Operator replay of a dead-lettered notification_outbox row. See the module
 * header for the two per-status mechanisms. Returns
 * `{ mode, row, replacement_id }`.
 */
export async function replayNotificationOutboxRow({
  tenantId,
  id,
  reason,
  actorUid,
  actorRole,
  requestId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const outboxId = normalizeOutboxId(id);
  const { operatorReason, uid, role } = requireOperator({ reason, actorUid, actorRole });
  const request = requestId ? String(requestId).slice(0, 180) : null;

  const result = await setTenantTx(tid, async (tx) => {
    const current = await tx.$queryRawUnsafe(
      `SELECT id, type, channel, status, recipient_id, recipient_phone, title,
              body, payload, source_event_key, template_version, retry_count, created_at,
              failure_reason, replay_generation
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND id = $2::integer
        LIMIT 1
        FOR UPDATE`,
      tid, outboxId,
    );
    if (!current[0]) throw AppError.notFound('Notification outbox row not found');
    const row = current[0];
    if (!['FAILED', 'RECONCILIATION_REQUIRED'].includes(row.status)) {
      throw AppError.conflict('Notification outbox row is not in a replayable dead-letter state');
    }

    let mode;
    let replacementId = null;
    let updated;
    let replayChannels = [];
    let resumedChannels = [];
    if (row.status === 'FAILED') {
      mode = 'retry_reset';
      ({ replayChannels, resumedChannels } = await resetFailedReplayCursorsTx(tx, tid, row));
      const rows = await tx.$queryRawUnsafe(
        `UPDATE notification_outbox
            SET retry_count = 0, last_attempt_at = NULL,
                failure_reason = 'operator_replay_requested'
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'FAILED'
          RETURNING id, status, retry_count, failure_reason`,
        tid, outboxId,
      );
      if (rows.length !== 1) throw AppError.conflict('Notification outbox replay lost its state fence');
      updated = rows[0];
    } else {
      if (row.failure_reason === OPERATOR_REPLAY_SUPERSEDED_REASON) {
        throw AppError.conflict('Notification outbox row was already replayed by an operator');
      }
      mode = 'requeued_new_intent';
      const requeued = await requeueSupersededIntentTx(tx, tid, row, {
        sourceMarker: 'operator-replay',
      });
      replacementId = requeued.replacementId;
      updated = requeued.updated;
      replayChannels = requeued.replayChannels;
      resumedChannels = requeued.resumedChannels;
    }

    await tx.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'NOTIFICATION_OUTBOX_REPLAYED',
               'notification_outbox', $4::text, $5::jsonb, NOW())`,
      tid, uid, role, String(outboxId),
      JSON.stringify({
        reason: operatorReason,
        request_id: request,
        mode,
        prior_status: row.status,
        prior_retry_count: Number(row.retry_count),
        prior_failure_reason: row.failure_reason || null,
        replacement_outbox_id: replacementId,
        duplicate_delivery_risk_accepted: mode === 'requeued_new_intent',
        replay_channels: replayChannels,
        resumed_channels: resumedChannels,
      }),
    );
    return { mode, row: updated, replacement_id: replacementId };
  }, { isolationLevel: 'Serializable' });
  recordOutboxOperatorRedrive('notification_outbox');
  return result;
}

const AUTO_REPLAY_DEFAULT_LIMIT = 25;
const AUTO_REPLAY_ACTOR = 'system:auto-replay-sweep';

/**
 * Bounded auto-replay sweep over RECONCILIATION_REQUIRED dead letters
 * (notification-outbox-auto-replay cron). Reuses the audited operator
 * requeue-as-new-intent mechanism per selected row; the sweep differs from
 * the operator path only in selection and provenance:
 *
 *   - fail-closed failure_reason allowlist (the two provider-uncertainty
 *     reasons only) — already-superseded, exhausted, and operator-stamped
 *     rows are never touched;
 *   - >= 30-minute backoff since the last attempt (operator grace window)
 *     and a 24-hour age ceiling (sos-alert-age-escalation idiom);
 *   - replay_generation bound: at most NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS
 *     auto requeues per intent chain — rows at the bound are stamped
 *     AUTO_REPLAY_EXHAUSTED_REASON exactly once (the idempotence marker for
 *     terminal alerting) and left for the operator endpoints;
 *   - audit_logs provenance uses action NOTIFICATION_OUTBOX_AUTO_REPLAYED
 *     with a NULL uid and metadata.actor = 'system:auto-replay-sweep'
 *     (requireOperator demands a human UUID; the sweep is not a human);
 *   - metrics go to notification_outbox_auto_replay_total{outcome}, never to
 *     outbox_operator_redrive_total (that counter means "a human acted").
 *
 * SUPPRESSED is deliberately NOT handled here: every production SUPPRESSED
 * row is an intentional "never send" (payroll attempt/payslip superseded), the
 * state machine has no transition out of SUPPRESSED, and re-sending would
 * deliver stale or wrong payslip notices. Visibility comes from the
 * notification_outbox_suppressed_rows gauge instead.
 *
 * Coordination note: replay-only channel routing is stored as internal outbox
 * metadata and stripped before provider dispatch. It is never caller payload.
 */
export async function autoReplayReconciliationRequiredRows({
  tenantId,
  limit = AUTO_REPLAY_DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = boundedInteger(limit, AUTO_REPLAY_DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');

  const result = await setTenantTx(tid, async (tx) => {
    // Newly-terminal chains: a replacement re-entered RECONCILIATION_REQUIRED
    // at the generation bound. Stamp the exhausted marker exactly once so the
    // alert fires once per chain; the row stays operator-replayable.
    const exhaustedRows = await tx.$queryRawUnsafe(
      `UPDATE notification_outbox
          SET failure_reason = $2::text
        WHERE tenant_id = $1::uuid
          AND status = 'RECONCILIATION_REQUIRED'
          AND replay_generation >= $3::smallint
          AND failure_reason = ANY($4::text[])
        RETURNING id, replay_generation`,
      tid, AUTO_REPLAY_EXHAUSTED_REASON, NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS,
      AUTO_REPLAYABLE_RECONCILIATION_REASONS,
    );

    const candidates = await tx.$queryRawUnsafe(
      `SELECT id, type, channel, recipient_id, recipient_phone, title, body,
              payload, source_event_key, template_version, retry_count, created_at,
              failure_reason, replay_generation
         FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND status = 'RECONCILIATION_REQUIRED'
          AND failure_reason = ANY($2::text[])
          AND replay_generation < $3::smallint
          AND COALESCE(last_attempt_at, created_at) < NOW() - INTERVAL '30 minutes'
          AND CASE
                WHEN replay_generation = 0 THEN created_at
                WHEN jsonb_typeof(payload -> $5::text) = 'number'
                  AND payload ->> $5::text ~ '^[0-9]{13}$'
                  THEN to_timestamp((payload ->> $5::text)::double precision / 1000.0)
                ELSE NULL
              END > NOW() - INTERVAL '24 hours'
        ORDER BY id
        LIMIT $4::integer
        FOR UPDATE SKIP LOCKED`,
      tid, AUTO_REPLAYABLE_RECONCILIATION_REASONS,
      NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS, safeLimit,
      REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY,
    );

    const requeued = [];
    for (const row of candidates) {
      const { replacementId, replayChannels, resumedChannels } = await requeueSupersededIntentTx(tx, tid, row, {
        sourceMarker: 'auto-replay',
      });
      await tx.$queryRawUnsafe(
        `INSERT INTO audit_logs
           (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
         VALUES ($1::uuid, NULL, 'system', 'NOTIFICATION_OUTBOX_AUTO_REPLAYED',
                 'notification_outbox', $2::text, $3::jsonb, NOW())`,
        tid, String(row.id),
        JSON.stringify({
          actor: AUTO_REPLAY_ACTOR,
          prior_status: 'RECONCILIATION_REQUIRED',
          prior_failure_reason: row.failure_reason || null,
          replacement_outbox_id: replacementId,
          replay_generation: Number(row.replay_generation ?? 0) + 1,
          duplicate_delivery_risk_accepted: true,
          replay_channels: replayChannels,
          resumed_channels: resumedChannels,
        }),
      );
      requeued.push({ id: row.id, replacement_id: replacementId });
    }
    return {
      requeued,
      exhausted: exhaustedRows.map(row => ({
        id: row.id,
        replay_generation: Number(row.replay_generation),
      })),
    };
  }, { isolationLevel: 'Serializable' });

  recordNotificationOutboxAutoReplay('requeued', result.requeued.length);
  recordNotificationOutboxAutoReplay('exhausted', result.exhausted.length);
  for (const row of result.exhausted) {
    logger.error(
      `notification-outbox-auto-replay: chain terminal — outbox row ${row.id} `
        + `(replay generation ${row.replay_generation}) has no automatic path left; `
        + 'operator replay or reconciliation required',
    );
  }
  return {
    tenant_id: tid,
    requeued: result.requeued.length,
    exhausted: result.exhausted.length,
    replacements: result.requeued,
  };
}

export const notificationOutboxAdminService = Object.freeze({
  listNotificationOutboxRows,
  reconcileNotificationOutboxAttempt,
  replayNotificationOutboxRow,
  autoReplayReconciliationRequiredRows,
});

export default notificationOutboxAdminService;
