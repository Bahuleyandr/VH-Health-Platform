import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Delivery-retry policy for the drain (mirrors webhookDeliveryService backoff).
// `attempts` is the count of failed delivery attempts. A row that fails delivery
// is backed off (available_at pushed into the future) and returned to 'pending'
// so the drain re-claims it after the floor; once it reaches MAX_ATTEMPTS it is
// parked at the terminal 'failed' status (dead-letter) and never re-claimed.
const MAX_ATTEMPTS = 7;
// Backoff in seconds keyed by the attempt number that just failed (index 0 = 1st
// failure). Caps at 8h so a wedged downstream dead-letters cleanly within a day.
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 14400, 28800];

function backoffSecondsForAttempt(attemptNumber) {
  const idx = Math.max(0, Math.min(attemptNumber, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[idx];
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload;
}

/**
 * Write one event_outbox row (status='pending') for a business event. The
 * drain (drainEventOutbox) later bridges it to the webhook delivery pipeline.
 *
 * Transaction awareness (optional `tx`):
 *   - DEFAULT (no tx) — best-effort on the plain `prisma` client: a failure is
 *     logged and swallowed (returns null) so a producer's happy path is never
 *     blocked by an outbox blip. This is the historical contract.
 *   - WITH `tx` — a safety-critical producer can pass its $transaction client so
 *     the outbox row is written ATOMICALLY with the business write (no lost
 *     events on a partial commit). In that mode the error is RE-THROWN, not
 *     swallowed: swallowing a Prisma error inside a $transaction silently aborts
 *     the whole tx (Phase-1.5 rule), so the caller must see the failure and roll
 *     back. The row's tenant_id comes from the GUC-reading column default, which
 *     a setTenantTx-wrapped tx has already set to the producer's tenant.
 *
 * @param {Object} args
 * @param {import('@prisma/client').Prisma.TransactionClient} [args.tx] optional tx client.
 */
export async function publishEvent({
  eventType,
  aggregateType,
  aggregateId = null,
  patientUid = null,
  payload = {},
  tx = null,
}) {
  if (!eventType || !aggregateType) {
    logger.warn('Skipped event_outbox insert: missing eventType or aggregateType', {
      eventType,
      aggregateType,
    });
    return null;
  }

  const client = tx ?? prisma;
  const insert = () => client.$queryRawUnsafe(
    `INSERT INTO event_outbox
       (event_type, aggregate_type, aggregate_id, patient_uid, payload, status, available_at, created_at)
     VALUES ($1, $2, $3, $4::uuid, $5::jsonb, 'pending', NOW(), NOW())
     RETURNING id, event_type, aggregate_type, aggregate_id, patient_uid, status, created_at`,
    eventType,
    aggregateType,
    aggregateId ? String(aggregateId) : null,
    patientUid || null,
    JSON.stringify(normalizePayload(payload))
  );

  // Inside a caller's tx, a swallowed error would silently abort the whole tx
  // (Phase-1.5 rule) — re-throw so the caller rolls back and sees the failure.
  if (tx) {
    const rows = await insert();
    return rows[0];
  }

  try {
    const rows = await insert();
    return rows[0];
  } catch (err) {
    logger.warn('Failed to publish event_outbox event', {
      eventType,
      aggregateType,
      error: err.message,
    });
    return null;
  }
}

export async function listEvents({ status = 'pending', limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const safeLimit = clampLimit(limit);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const allowedStatuses = new Set(['pending', 'processing', 'delivered', 'failed']);
  const safeStatus = allowedStatuses.has(status) ? status : 'pending';

  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, aggregate_type, aggregate_id, patient_uid, payload,
            status, attempts, available_at, last_error, created_at, delivered_at
     FROM event_outbox
     WHERE status = $1
     ORDER BY available_at ASC, id ASC
     LIMIT $2 OFFSET $3`,
    safeStatus,
    safeLimit,
    safeOffset
  );
}

/**
 * Atomically claim a batch of due event_outbox rows for draining.
 *
 * Mirrors notificationOutbox.claimPendingBatch: a single UPDATE flips the
 * claimed rows to 'processing' where the inner SELECT uses FOR UPDATE SKIP
 * LOCKED on the (status, available_at, id) claim index, so concurrent drain
 * runners (worker×replica fleet) each lock a DISJOINT slice and skip past
 * rows another runner already holds rather than blocking. Only 'pending' rows
 * whose available_at <= now are eligible (respects the failure backoff).
 *
 * Returned rows carry everything the drain needs to bridge + mark each row:
 * id, event_type, aggregate_type, aggregate_id, patient_uid, payload, attempts,
 * tenant_id.
 *
 * Best-effort: returns [] on any error (matches publishEvent's never-throw
 * posture so a transient DB blip can't crash the cron tick).
 *
 * @param {number} limit Max rows to claim.
 * @returns {Promise<Array>} Claimed rows (status now 'processing').
 */
export async function claimPendingEvents(limit = DEFAULT_LIMIT) {
  const safeLimit = clampLimit(limit);
  try {
    return await prisma.$queryRawUnsafe(
      `UPDATE event_outbox
          SET status = 'processing'
        WHERE id IN (
          SELECT id FROM event_outbox
           WHERE status = 'pending'
             AND available_at <= NOW()
           ORDER BY available_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING id, event_type, aggregate_type, aggregate_id, patient_uid,
                  payload, status, attempts, available_at, tenant_id`,
      safeLimit,
    );
  } catch (err) {
    logger.warn('Failed to claim event_outbox batch', { error: err.message });
    return [];
  }
}

export async function markDelivered(eventId) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE event_outbox
     SET status = 'delivered', delivered_at = NOW(), last_error = NULL
     WHERE id = $1::bigint
     RETURNING id, status, delivered_at`,
    eventId
  );
  return rows[0] || null;
}

/**
 * Record a delivery failure for an event_outbox row.
 *
 * Increments `attempts`, records `last_error`, and applies the retry policy:
 *   - below MAX_ATTEMPTS → status back to 'pending' with `available_at` pushed
 *     forward by the exponential backoff, so the drain re-claims it after the
 *     floor (a backed-off row is NOT re-claimed before its available_at because
 *     claimPendingEvents filters `available_at <= NOW()`).
 *   - at/after MAX_ATTEMPTS → terminal 'failed' (dead-letter): the row stops
 *     being eligible for the drain and waits for an admin redrive.
 *
 * Runs in a short $transaction that locks the row (SELECT … FOR UPDATE) before
 * computing the next attempt count + backoff bucket, so concurrent failures for
 * the same row serialise instead of racing. Best-effort: returns null and logs
 * on any error (never throws — matches the cron-tick posture).
 *
 * @param {string|number|bigint} eventId
 * @param {string} message Failure reason (truncated to 2000 chars).
 * @returns {Promise<Object|null>} Updated row, or null if not found.
 */
export async function markFailed(eventId, message) {
  const reason = String(message || 'Unknown delivery failure').slice(0, 2000);
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock + read the current attempt count so the backoff bucket maps to the
      // real ladder (30,120,600,…) — a single arithmetic UPDATE can't express an
      // arbitrary ladder. FOR UPDATE serialises concurrent failures for this row.
      const current = await tx.$queryRawUnsafe(
        `SELECT attempts FROM event_outbox WHERE id = $1::bigint FOR UPDATE`,
        eventId,
      );
      if (!current[0]) return null;
      const priorAttempts = Number(current[0].attempts) || 0;
      const nextAttempts = priorAttempts + 1;
      // priorAttempts is the 0-based index of the attempt that just failed.
      const backoff = backoffSecondsForAttempt(priorAttempts);
      const deadLetter = nextAttempts >= MAX_ATTEMPTS;

      const rows = await tx.$queryRawUnsafe(
        deadLetter
          ? `UPDATE event_outbox
                SET attempts = $3::int, last_error = $2, status = 'failed'
              WHERE id = $1::bigint
              RETURNING id, status, attempts, available_at, last_error`
          : `UPDATE event_outbox
                SET attempts = $3::int, last_error = $2, status = 'pending',
                    available_at = NOW() + ($4::int * INTERVAL '1 second')
              WHERE id = $1::bigint
              RETURNING id, status, attempts, available_at, last_error`,
        ...(deadLetter
          ? [eventId, reason, nextAttempts]
          : [eventId, reason, nextAttempts, backoff]),
      );
      return rows[0] || null;
    });
  } catch (err) {
    logger.warn('Failed to mark event_outbox row failed', {
      eventId: String(eventId),
      error: err.message,
    });
    return null;
  }
}

export default {
  publishEvent,
  listEvents,
  claimPendingEvents,
  markDelivered,
  markFailed,
};
