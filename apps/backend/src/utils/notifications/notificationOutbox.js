import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// notification_outbox.recipient_id is a TEXT column that may carry either an
// integer users.id or a uuid users.uid — the delivery path resolves both forms
// (id::text / uid::text matches in notificationOutboxDelivery.js). Preserve any
// non-blank identifier verbatim as text; blank / null / unsupported types
// normalize to NULL (phone-only rows are valid).
const toRecipientIdTextOrNull = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : null;
  }
  if (typeof value === 'bigint') return value.toString();
  return null;
};

/**
 * Notification outbox — persist notification intent before sending.
 * Failed notifications can be retried by a background job.
 *
 * Usage:
 *   await notificationOutbox.queue({ type: 'push', recipientId: userIdOrUid, title, body, data: {...} });
 *   // Then attempt to send immediately
 *   // If send fails, the outbox entry remains for retry
 */
class NotificationOutbox {
  /**
   * Queue a notification for delivery.
   * @param {Object} notification - { type: 'push'|'sms'|'email', recipientId, recipientPhone, title, body, data, channel }
   *   `recipientId` accepts an integer users.id or a uuid users.uid and is
   *   persisted as text; blank/null normalizes to NULL.
   * @returns {Object} The queued notification record
   */
  async queue(notification) {
    try {
      const recipientId = toRecipientIdTextOrNull(notification.recipientId);

      const result = await prisma.$queryRawUnsafe(
        `INSERT INTO notification_outbox
          (type, recipient_id, recipient_phone, title, body, payload, status, created_at)
         VALUES ($1, $2::text, $3, $4, $5, $6::jsonb, 'PENDING', NOW())
         RETURNING id, status`,

          notification.type || 'push',
          recipientId,
          notification.recipientPhone || null,
          notification.title || '',
          notification.body || '',
          JSON.stringify(notification.data || {}),

      );
      return result[0];
    } catch (err) {
      logger.warn('Notification outbox queue failed:', err.message);
      return null;
    }
  }

  /**
   * Mark a notification as sent.
   */
  async markSent(outboxId) {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE notification_outbox
         SET status = 'SENT',
             sent_at = NOW(),
             last_attempt_at = NOW()
         WHERE id = $1`,
        outboxId
      );
    } catch (err) {
      logger.warn('Failed to mark outbox entry as sent:', err.message);
    }
  }

  /**
   * Mark a notification as failed with reason.
   */
  async markFailed(outboxId, reason) {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE notification_outbox
         SET status = 'FAILED',
             failure_reason = $2,
             retry_count = retry_count + 1,
             last_attempt_at = NOW()
         WHERE id = $1`,
        outboxId, reason
      );
    } catch (err) {
      logger.warn('Failed to mark outbox entry as failed:', err.message);
    }
  }

  /**
   * Get pending notifications for retry.
   * @param {number} limit - Max notifications to fetch
   * @returns {Array} Pending notifications
   */
  async getPendingForRetry(limit = 50) {
    try {
      const result = await prisma.$queryRawUnsafe(
        `SELECT id, type, recipient_id, recipient_phone, title, body, payload, retry_count
         FROM notification_outbox
         WHERE status IN ('PENDING', 'FAILED')
           AND retry_count < 3
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '5 minutes')
         ORDER BY created_at ASC
         LIMIT $1`,
        limit
      );
      return result;
    } catch (err) {
      logger.warn('Failed to fetch pending notifications:', err.message);
      return [];
    }
  }

  /**
   * Atomically claim a batch of due outbox rows for draining.
   *
   * Uses `FOR UPDATE SKIP LOCKED` inside a transaction so that concurrent
   * drain runners (multiple cluster workers / replicas) never pick the same
   * row — each claimer locks a disjoint slice and the rest skip past locked
   * rows instead of blocking. The drain cron is ALSO guarded by a
   * cross-process advisory lock (withJobLock), so in practice one runner wins
   * per tick; SKIP LOCKED is the belt-and-braces against any overlap window.
   *
   * Eligibility mirrors getPendingForRetry: still PENDING/FAILED, under the
   * retry cap, and either never attempted or past the 5-minute backoff floor.
   * Rows are returned to the caller still inside the open transaction's lock;
   * the lock releases when this method's transaction commits. We do not hold
   * the lock across the network send — we read, release, then send + mark by
   * id. That trades a (tiny) double-send risk under true concurrency for not
   * holding row locks across slow FCM/SMS calls; SKIP LOCKED + the advisory
   * lock keep that window effectively closed.
   *
   * @param {number} limit Max rows to claim.
   * @returns {Array} Claimed outbox rows.
   */
  async claimPendingBatch(limit = 50) {
    try {
      const rows = await prisma.$transaction(async (tx) => {
        return tx.$queryRawUnsafe(
          `SELECT id, type, recipient_id, recipient_phone, title, body, payload, retry_count
             FROM notification_outbox
            WHERE status IN ('PENDING', 'FAILED')
              AND retry_count < 3
              AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '5 minutes')
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          limit
        );
      });
      return rows;
    } catch (err) {
      logger.warn('Failed to claim outbox batch:', err.message);
      return [];
    }
  }
}

export const notificationOutbox = new NotificationOutbox();
export default notificationOutbox;
