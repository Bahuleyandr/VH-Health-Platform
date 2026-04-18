import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

/**
 * Notification outbox — persist notification intent before sending.
 * Failed notifications can be retried by a background job.
 *
 * Usage:
 *   await notificationOutbox.queue({ type: 'push', recipient: userId, payload: {...} });
 *   // Then attempt to send immediately
 *   // If send fails, the outbox entry remains for retry
 */
class NotificationOutbox {
  /**
   * Queue a notification for delivery.
   * @param {Object} notification - { type: 'push'|'sms'|'email', recipientId, recipientPhone, title, body, data, channel }
   * @returns {Object} The queued notification record
   */
  async queue(notification) {
    try {
      const result = await prisma.$queryRawUnsafe(
        `INSERT INTO notification_outbox
          (type, recipient_id, recipient_phone, title, body, payload, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
         RETURNING id, status`,
        
          notification.type || 'push',
          notification.recipientId || null,
          notification.recipientPhone || null,
          notification.title || '',
          notification.body || '',
          JSON.stringify(notification.data || {}),
        
      );
      return result[0];
    } catch (err) {
      // If outbox table doesn't exist yet, log and continue (graceful degradation)
      logger.warn('Notification outbox queue failed (table may not exist):', err.message);
      return null;
    }
  }

  /**
   * Mark a notification as sent.
   */
  async markSent(outboxId) {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE notification_outbox SET status = 'SENT', sent_at = NOW() WHERE id = $1`,
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
         SET status = 'FAILED', failure_reason = $2, retry_count = retry_count + 1, last_attempt_at = NOW()
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
}

export const notificationOutbox = new NotificationOutbox();
export default notificationOutbox;
