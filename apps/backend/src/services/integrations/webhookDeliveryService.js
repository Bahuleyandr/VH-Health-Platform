/**
 * Webhook delivery service (Phase A3 PR2).
 *
 * Pipeline:
 *
 *   enqueueDelivery   ── creates one webhook_deliveries row per matching
 *                        active subscription with status='pending'.
 *
 *   dispatchPendingDeliveries (called from a cron) ──
 *     1. Claim a batch of due rows: status IN ('pending','failed') AND
 *        next_retry_at <= NOW(); flip them to in_flight in one update.
 *     2. For each, sign + POST. Update status to succeeded / failed /
 *        dead based on the response. Schedule next_retry_at on retryable
 *        failures using exponential backoff. After RETRY_LIMIT attempts,
 *        the row is marked 'dead' and the subscription's failure
 *        counter increments (which may auto-pause it).
 *
 *   markDeliveryDead, redriveDelivery — admin escape hatches.
 *
 * Decision-support only: this is the ONLY place that opens an outbound
 * connection; callers describe intent + we audit every attempt.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { decryptField } from '../../utils/fieldEncryption.js';
import { assertSafeOutboundUrl } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { writeIntegrationLog } from './integrationService.js';
import {
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  signWebhookPayload,
} from './webhookSubscriptionService.js';

export const DELIVERY_STATUSES = ['pending', 'in_flight', 'succeeded', 'failed', 'dead'];

const RETRY_LIMIT = 7;
// Exponential-ish backoff in seconds; index = attempt_number that just
// failed. Caps at 8 hours so a wedged endpoint dies cleanly within a day.
const BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600, 14_400, 28_800];

const DEFAULT_BATCH = 25;
const MAX_BATCH = 200;
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_EXCERPT_MAX = 2_000;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function safeText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function backoffSecondsForAttempt(attemptNumber) {
  const idx = Math.max(0, Math.min(attemptNumber, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[idx];
}

function computeNextRetryAt(attemptNumber) {
  const seconds = backoffSecondsForAttempt(attemptNumber);
  return new Date(Date.now() + seconds * 1000);
}

function isRetryable(httpStatus) {
  if (httpStatus == null) return true;          // network / timeout
  if (httpStatus >= 500 && httpStatus < 600) return true;
  if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Find every active subscription for (tenantId, eventType) and create a
 * pending webhook_deliveries row per match. Returns the inserted rows.
 *
 * Caller is typically the event_outbox worker; for ad-hoc admin tests
 * the same call shape works (admins can replay any event_type / payload).
 */
export async function enqueueDelivery({
  tenantId = null,
  eventType,
  payload = {},
  eventOutboxId = null,
  requestId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanType = safeText(eventType, 120);
  if (!cleanType) throw AppError.badRequest('event_type is required');

  let subscriptions;
  try {
    subscriptions = await prisma.$queryRawUnsafe(
      `SELECT id, integration_id, endpoint_url, signing_credential_id,
              signing_algorithm, max_consecutive_failures
       FROM webhook_subscriptions
       WHERE tenant_id = $1::uuid
         AND event_type = $2
         AND is_active = true`,
      tid, cleanType,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { matched: 0, enqueued: [], skipped_reason: 'webhook_subscriptions_unavailable' };
    }
    throw err;
  }

  if (!subscriptions.length) {
    return { matched: 0, enqueued: [] };
  }

  const enqueued = [];
  for (const sub of subscriptions) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO webhook_deliveries
           (subscription_id, tenant_id, event_outbox_id, event_type,
            payload, status, attempt_number, next_retry_at, request_id)
         VALUES ($1, $2::uuid, $3, $4, $5::jsonb, 'pending', 0, NOW(), $6)
         RETURNING id, subscription_id, tenant_id, event_outbox_id,
                   event_type, status, attempt_number, next_retry_at,
                   created_at`,
        sub.id, tid, eventOutboxId ? Number.parseInt(eventOutboxId, 10) : null,
        cleanType, JSON.stringify(payload || {}),
        requestId || crypto.randomUUID(),
      );
      enqueued.push(rows[0]);
    } catch (err) {
      if (isMissingSchemaError(err)) {
        return { matched: subscriptions.length, enqueued, skipped_reason: 'webhook_deliveries_unavailable' };
      }
      logger.warn('webhook delivery enqueue failed', {
        subscription_id: sub.id, error: err.message,
      });
    }
  }
  return { matched: subscriptions.length, enqueued };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Claim a batch of due deliveries and POST them. Cron-driven. Each call
 * dispatches at most `batchSize` rows; subsequent ticks pick up the
 * rest. Per-tenant if tenantId is supplied; otherwise scans all tenants.
 *
 * Returns { dispatched, succeeded, failed, dead } counts.
 */
export async function dispatchPendingDeliveries({
  tenantId = null,
  batchSize = DEFAULT_BATCH,
  fetchImpl = null,
} = {}) {
  const cap = Math.min(Math.max(Number.parseInt(batchSize, 10) || DEFAULT_BATCH, 1), MAX_BATCH);
  const fetcher = fetchImpl || globalThis.fetch;

  let claimed;
  const claimSql = tenantId
    ? `UPDATE webhook_deliveries
       SET status = 'in_flight',
           attempt_number = attempt_number + 1,
           started_at = NOW(),
           updated_at = NOW()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE tenant_id = $1::uuid
           AND status IN ('pending', 'failed')
           AND next_retry_at <= NOW()
         ORDER BY next_retry_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       RETURNING id, subscription_id, tenant_id, event_outbox_id,
                 event_type, payload, attempt_number, request_id`
    : `UPDATE webhook_deliveries
       SET status = 'in_flight',
           attempt_number = attempt_number + 1,
           started_at = NOW(),
           updated_at = NOW()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status IN ('pending', 'failed')
           AND next_retry_at <= NOW()
         ORDER BY next_retry_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING id, subscription_id, tenant_id, event_outbox_id,
                 event_type, payload, attempt_number, request_id`;

  try {
    claimed = tenantId
      ? await prisma.$queryRawUnsafe(claimSql, tenantId, cap)
      : await prisma.$queryRawUnsafe(claimSql, cap);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { halted: true, reason: 'webhook_deliveries_unavailable' };
    }
    throw err;
  }

  let succeeded = 0;
  let failed = 0;
  let dead = 0;
  for (const row of claimed) {
    let subscription = null;
    try {
      const subRows = await prisma.$queryRawUnsafe(
        `SELECT s.id, s.integration_id, s.tenant_id, s.endpoint_url,
                s.signing_credential_id, s.signing_algorithm,
                c.id AS credential_id, c.ciphertext
         FROM webhook_subscriptions s
         LEFT JOIN integration_credentials c
           ON c.id = s.signing_credential_id
          AND c.tenant_id = s.tenant_id
          AND c.integration_id = s.integration_id
         WHERE s.id = $1 AND s.tenant_id = $2::uuid
         LIMIT 1`,
        row.subscription_id,
        row.tenant_id,
      );
      subscription = subRows[0];
    } catch (err) {
      logger.warn('webhook subscription fetch failed', { id: row.subscription_id, error: err.message });
    }

    if (!subscription) {
      // Subscription disappeared — kill the delivery.
      await markStatus(row.id, {
        status: 'dead',
        error: 'subscription_missing',
        completedAt: new Date(),
      });
      dead += 1;
      continue;
    }

    let signed = { signature: '', header_value: '', algorithm: subscription.signing_algorithm, timestamp: null };
    const url = subscription.endpoint_url;
    let httpStatus = null;
    let responseExcerpt = null;
    let errorMessage = null;
    try {
      await assertSafeOutboundUrl(url, {
        label: 'endpoint_url',
        allowlistEnv: 'WEBHOOK_DELIVERY_HOST_ALLOWLIST',
        allowPrivateEnv: 'WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS',
      });
      if (subscription.signing_algorithm !== 'none') {
        if (!subscription.credential_id || !subscription.ciphertext) {
          throw AppError.forbidden(
            'Webhook signing credential is missing or not owned by this tenant integration',
            'WEBHOOK_SIGNING_CREDENTIAL_FORBIDDEN',
          );
        }
        signed = signWebhookPayload({
          payload: row.payload,
          secret: decryptField(subscription.ciphertext),
          algorithm: subscription.signing_algorithm,
        });
      }
    } catch (err) {
      errorMessage = String(err?.message || 'webhook_preflight_failed').slice(0, 1_000);
      logger.warn('webhook delivery preflight failed', { delivery_id: row.id, error: errorMessage });
    }

    if (!errorMessage) {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-VHHealth-Signature': signed.header_value,
            'X-VHHealth-Event-Type': row.event_type,
            'X-VHHealth-Delivery-Id': String(row.id),
            'X-Request-Id': row.request_id || crypto.randomUUID(),
          },
          body: JSON.stringify(row.payload || {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        httpStatus = response.status;
        try {
          const text = await response.text();
          responseExcerpt = text ? text.slice(0, RESPONSE_EXCERPT_MAX) : null;
        } catch {
          responseExcerpt = null;
        }
      } catch (err) {
        errorMessage = String(err?.message || 'fetch_failed').slice(0, 1_000);
      }
    }

    const ok = httpStatus != null && httpStatus >= 200 && httpStatus < 300;
    if (ok) {
      await markStatus(row.id, {
        status: 'succeeded',
        httpStatus,
        responseExcerpt,
        signature: signed.signature || null,
        completedAt: new Date(),
      });
      await recordSubscriptionSuccess({ tenantId: row.tenant_id, id: row.subscription_id });
      try {
        await writeIntegrationLog({
          tenantId: row.tenant_id,
          integrationId: subscription.integration_id,
          logType: 'webhook_send',
          severity: 'info',
          message: `Delivered ${row.event_type} to ${url} (HTTP ${httpStatus})`,
          payload: { delivery_id: row.id, attempt: row.attempt_number },
        });
      } catch (logErr) {
        logger.debug('webhook send log write failed', { error: logErr.message });
      }
      succeeded += 1;
      continue;
    }

    const retryable = isRetryable(httpStatus) && row.attempt_number < RETRY_LIMIT;
    const nextStatus = retryable ? 'failed' : 'dead';
    const nextRetryAt = retryable ? computeNextRetryAt(row.attempt_number) : null;

    await markStatus(row.id, {
      status: nextStatus,
      httpStatus,
      responseExcerpt,
      errorMessage,
      signature: signed.signature || null,
      nextRetryAt,
      completedAt: nextStatus === 'dead' ? new Date() : null,
    });
    if (nextStatus === 'dead') {
      dead += 1;
    } else {
      failed += 1;
    }
    await recordSubscriptionFailure({ tenantId: row.tenant_id, id: row.subscription_id });
    try {
      await writeIntegrationLog({
        tenantId: row.tenant_id,
        integrationId: subscription.integration_id,
        logType: nextStatus === 'dead' ? 'error' : 'webhook_send',
        severity: nextStatus === 'dead' ? 'error' : 'warn',
        message: `Delivery ${nextStatus}: ${row.event_type} → ${url} (HTTP ${httpStatus ?? 'n/a'})`,
        payload: {
          delivery_id: row.id,
          attempt: row.attempt_number,
          next_retry_at: nextRetryAt,
          error: errorMessage,
        },
      });
    } catch (logErr) {
      logger.debug('webhook send log write failed', { error: logErr.message });
    }
  }

  return { dispatched: claimed.length, succeeded, failed, dead };
}

/**
 * Reaper for stale in_flight deliveries (audit 2026-06-22 M10). dispatchPending
 * Deliveries claims rows by flipping them to 'in_flight'; if the worker crashes
 * AFTER the claim but BEFORE marking the row succeeded/failed/dead, the row stays
 * 'in_flight' forever — the claim only re-picks 'pending'/'failed', so a crashed
 * delivery never retries and never dead-letters. Reset rows that have been
 * in_flight longer than `staleMinutes` back to 'failed' + due now, so the next
 * dispatch pass re-claims them (and they eventually dead-letter via the normal
 * MAX-attempts path). Run from a cron tick.
 */
export async function reapStaleInFlightDeliveries({ staleMinutes = 15 } = {}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE webhook_deliveries
          SET status = 'failed',
              last_error = 'reaped: stale in_flight (worker crashed mid-delivery)',
              next_retry_at = NOW(),
              updated_at = NOW()
        WHERE status = 'in_flight'
          AND started_at < NOW() - ($1::int * INTERVAL '1 minute')
        RETURNING id`,
      Number(staleMinutes) || 15,
    );
    return { reaped: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reaped: 0 };
    throw err;
  }
}

async function markStatus(id, {
  status,
  httpStatus = null,
  responseExcerpt = null,
  errorMessage = null,
  signature = null,
  nextRetryAt = null,
  completedAt = null,
}) {
  try {
    await prisma.$queryRawUnsafe(
      `UPDATE webhook_deliveries
       SET status = $1,
           http_status = COALESCE($2, http_status),
           response_excerpt = COALESCE($3, response_excerpt),
           error_message = COALESCE($4, error_message),
           signature = COALESCE($5, signature),
           next_retry_at = $6,
           completed_at = COALESCE($7, completed_at),
           updated_at = NOW()
       WHERE id = $8`,
      status,
      httpStatus,
      responseExcerpt,
      errorMessage,
      signature,
      nextRetryAt,
      completedAt,
      id,
    );
  } catch (err) {
    logger.warn('webhook delivery markStatus failed', { id, status, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

export async function listDeliveries({
  tenantId = null,
  subscriptionId = null,
  status = null,
  eventType = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (subscriptionId) {
    params.push(normalizeId(subscriptionId, 'subscription_id'));
    filters.push(`subscription_id = $${params.length}`);
  }
  if (status) {
    if (!DELIVERY_STATUSES.includes(String(status))) {
      throw AppError.badRequest(`status must be one of: ${DELIVERY_STATUSES.join(', ')}`);
    }
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (eventType) {
    params.push(safeText(eventType, 120));
    filters.push(`event_type = $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 500);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, subscription_id, tenant_id, event_outbox_id, event_type,
              status, attempt_number, http_status, response_excerpt,
              error_message, signature, request_id, started_at,
              completed_at, next_retry_at, created_at, updated_at
       FROM webhook_deliveries
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { deliveries: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { deliveries: [], count: 0 };
    throw err;
  }
}

export async function getDelivery({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const did = normalizeId(id, 'delivery id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, subscription_id, tenant_id, event_outbox_id, event_type,
            payload, status, attempt_number, http_status, response_excerpt,
            error_message, signature, request_id, started_at,
            completed_at, next_retry_at, created_at, updated_at
     FROM webhook_deliveries
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    did, tid,
  );
  if (!rows[0]) throw AppError.notFound('Webhook delivery not found');
  return rows[0];
}

export async function markDeliveryDead({
  tenantId = null,
  id,
  reason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const did = normalizeId(id, 'delivery id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE webhook_deliveries
     SET status = 'dead',
         error_message = COALESCE($1, error_message),
         next_retry_at = NULL,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status IN ('pending', 'failed')
     RETURNING id, subscription_id, status, error_message, completed_at`,
    safeText(reason, 1_000), did, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Pending or failed webhook delivery not found');
  }
  return rows[0];
}

/**
 * Re-arm a dead or already-succeeded delivery. The dispatcher will pick
 * it up on the next tick. Use sparingly; integration_logs records the
 * redrive so an admin trail exists.
 */
export async function redriveDelivery({
  tenantId = null,
  id,
  redrivenBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const did = normalizeId(id, 'delivery id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE webhook_deliveries
     SET status = 'pending',
         next_retry_at = NOW(),
         completed_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status IN ('dead', 'succeeded', 'failed')
     RETURNING id, subscription_id, tenant_id, event_type, status, attempt_number`,
    did, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Webhook delivery not eligible for redrive');
  }
  // Best-effort log
  try {
    await writeIntegrationLog({
      tenantId: tid,
      integrationId: null,
      logType: 'webhook_send',
      severity: 'info',
      message: `Delivery ${rows[0].id} redriven for ${rows[0].event_type}`,
      payload: { redriven_by: redrivenBy ? String(redrivenBy) : null },
    });
  } catch (logErr) {
    logger.debug('redrive log write failed', { error: logErr.message });
  }
  return rows[0];
}

export const __testing__ = {
  BACKOFF_SECONDS,
  DELIVERY_STATUSES,
  RETRY_LIMIT,
  backoffSecondsForAttempt,
  computeNextRetryAt,
  isRetryable,
};

export default {
  dispatchPendingDeliveries,
  enqueueDelivery,
  getDelivery,
  listDeliveries,
  markDeliveryDead,
  redriveDelivery,
};
