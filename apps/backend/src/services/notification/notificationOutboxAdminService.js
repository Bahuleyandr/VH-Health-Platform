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
import { setTenantTx } from '../../lib/prisma.js';
import { recordOutboxOperatorRedrive } from '../../observability/reliabilityMetrics.js';
import { AppError } from '../../utils/AppError.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { OPERATOR_REPLAY_SUPERSEDED_REASON } from '../../utils/notifications/terminalRejectionCodes.js';
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
              body, payload, source_event_key, template_version, retry_count,
              failure_reason
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
    if (row.status === 'FAILED') {
      mode = 'retry_reset';
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
      await tx.$executeRawUnsafe(
        `UPDATE notification_delivery_cursors
            SET state = 'ready', blocked_outbox_id = NULL,
                inflight_outbox_id = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND channel = $2::text
            AND state IN ('paused_rejected', 'paused_uncertain')
            AND blocked_outbox_id = $3::integer`,
        tid, row.channel, outboxId,
      );
    } else {
      if (row.failure_reason === OPERATOR_REPLAY_SUPERSEDED_REASON) {
        throw AppError.conflict('Notification outbox row was already replayed by an operator');
      }
      mode = 'requeued_new_intent';
      const replacement = await notificationOutbox.queue({
        type: row.type,
        channel: row.channel,
        recipientId: row.recipient_id,
        recipientPhone: row.recipient_phone,
        tenantId: tid,
        title: row.title,
        body: row.body,
        templateVersion: row.template_version,
        sourceEventKey: `${String(row.source_event_key)}:operator-replay:${outboxId}`.slice(0, 255),
        data: row.payload && typeof row.payload === 'object' ? row.payload : {},
      }, { tx, strict: true });
      replacementId = replacement?.id ?? null;
      const rows = await tx.$queryRawUnsafe(
        `UPDATE notification_outbox
            SET failure_reason = $3::text
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'RECONCILIATION_REQUIRED'
          RETURNING id, status, retry_count, failure_reason`,
        tid, outboxId, OPERATOR_REPLAY_SUPERSEDED_REASON,
      );
      if (rows.length !== 1) throw AppError.conflict('Notification outbox replay lost its state fence');
      updated = rows[0];
      // If the channel cursor is paused ON this row, resume it in the same
      // transaction — the superseded row no longer blocks ordering.
      await tx.$executeRawUnsafe(
        `UPDATE notification_delivery_cursors
            SET state = 'ready', blocked_outbox_id = NULL,
                inflight_outbox_id = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND channel = $2::text
            AND state IN ('paused_rejected', 'paused_uncertain')
            AND blocked_outbox_id = $3::integer`,
        tid, row.channel, outboxId,
      );
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
      }),
    );
    return { mode, row: updated, replacement_id: replacementId };
  }, { isolationLevel: 'Serializable' });
  recordOutboxOperatorRedrive('notification_outbox');
  return result;
}

export const notificationOutboxAdminService = Object.freeze({
  listNotificationOutboxRows,
  reconcileNotificationOutboxAttempt,
  replayNotificationOutboxRow,
});

export default notificationOutboxAdminService;
