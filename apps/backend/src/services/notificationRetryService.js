// src/services/notificationRetryService.js
// Self-healing notification retry — wraps push/SMS with automatic retry on failure

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';


import { maskPhoneForLog } from '../utils/logMasking.js';
const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    return prisma.$queryRawUnsafe(normalizedSql, ...params);
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return { rowCount: Number(rowCount) || 0 };
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toUuidOrNull = (value) => {
  if (!value) return null;
  const normalized = String(value).trim();
  return UUID_PATTERN.test(normalized) ? normalized : null;
};

/**
 * Send push notification with automatic retry on failure.
 * On failure, queues to failed_notifications table for exponential backoff retry.
 */
export async function sendPushWithRetry(deviceToken, payload, userId = null) {
  try {
    const { sendPushNotification } = await import('../utils/notifications/sendPushNotification.js');
    await sendPushNotification({
      tokens: deviceToken,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      userId,
    });
  } catch (err) {
    logger.warn(`[RetryService] Push failed for user ${userId}, queuing retry: ${err.message}`);
    try {
      await query(`
        INSERT INTO failed_notifications (user_id, type, device_token, title, body, data, error_message, next_retry_at)
        VALUES ($1::uuid, 'push', $2, $3, $4, $5::jsonb, $6, NOW())
      `, [
        toUuidOrNull(userId),
        deviceToken,
        payload.title,
        payload.body,
        JSON.stringify(payload.data || {}),
        err.message,
      ]);
    } catch (dbErr) {
      logger.error(`[RetryService] Failed to queue push retry: ${dbErr.message}`);
    }
  }
}

/**
 * Record an SMS intent on the notification outbox, which owns durable retry
 * (5-min backoff, 3 attempts, per-tenant channel cursor). There is no SMS
 * gateway, so this never reports a send — the outbox drain resolves the row
 * with an honest `sms_gateway_not_configured` provider receipt
 * (audit 2026-08-09 finding F7).
 *
 * If the outbox itself cannot record the intent, fall back to the legacy
 * failed_notifications backoff table so the intent is not simply lost.
 */
export async function sendSMSWithRetry(phone, message, userId = null) {
  let failureReason = 'notification outbox queue returned no row';
  try {
    const { queuePatientSms } = await import('../utils/notifications/smsOutbox.js');
    const result = await queuePatientSms({
      recipientId: userId,
      recipientPhone: phone,
      title: 'Notification',
      body: message,
      data: { type: 'sms_retry_service' },
      context: 'notification-retry-service',
    });
    if (result.queued) return;
    failureReason = result.reason || failureReason;
  } catch (err) {
    failureReason = err.message;
  }

  logger.warn(`[RetryService] SMS intent not recorded for ${maskPhoneForLog(phone)}, queuing retry: ${failureReason}`);
  try {
    await query(`
      INSERT INTO failed_notifications (user_id, type, phone, body, error_message, next_retry_at)
      VALUES ($1::uuid, 'sms', $2, $3, $4, NOW())
    `, [toUuidOrNull(userId), phone, message, failureReason]);
  } catch (dbErr) {
    logger.error(`[RetryService] Failed to queue SMS retry: ${dbErr.message}`);
  }
}

/**
 * Process failed notifications with exponential backoff.
 * Called by scheduler every 5 minutes.
 * Backoff: 5min → 10min → 20min → 40min then permanent failure.
 */
export async function retryFailedNotifications() {
  let pending;
  try {
    pending = await query(`
      SELECT id, user_id, phone, device_token, title, body, type, data, error_message, retry_count, max_retries, last_retry_at, created_at, tenant_id::text AS tenant_id
      FROM failed_notifications
      WHERE status = 'pending' AND next_retry_at <= NOW() AND retry_count < max_retries
      ORDER BY created_at ASC LIMIT 50
    `);
  } catch (err) {
    logger.error(`[RetryService] Failed to query pending notifications: ${err.message}`);
    return;
  }

  if (pending.length === 0) return;

  logger.info(`[RetryService] Processing ${pending.length} failed notifications...`);

  for (const notif of pending) {
    try {
      if (notif.type === 'push' && notif.device_token) {
        const { sendPushNotification } = await import('../utils/notifications/sendPushNotification.js');
        await sendPushNotification({
          tokens: notif.device_token,
          title: notif.title,
          body: notif.body,
          data: notif.data || {},
          userId: notif.user_id,
        });
        await query(`UPDATE failed_notifications SET status='sent', last_retry_at=NOW() WHERE id=$1`, [notif.id]);
        logger.info(`[RetryService] Push retry succeeded for notification ${notif.id}`);
      } else if (notif.type === 'sms' && notif.phone) {
        // Hand the intent to the notification outbox, which is the durable
        // owner of SMS delivery state. The row leaves this backoff table as
        // 'queued_outbox' — never 'sent', because no SMS gateway exists.
        const { queuePatientSms } = await import('../utils/notifications/smsOutbox.js');
        const queued = await queuePatientSms({
          tenantId: notif.tenant_id || null,
          recipientId: notif.user_id || null,
          recipientPhone: notif.phone,
          title: notif.title || 'Notification',
          body: notif.body,
          data: { type: 'sms_retry_service', failed_notification_id: String(notif.id) },
          context: 'notification-retry-service',
        });
        if (!queued.queued) throw new Error(`outbox queue failed: ${queued.reason}`);
        await query(`UPDATE failed_notifications SET status='queued_outbox', last_retry_at=NOW() WHERE id=$1`, [notif.id]);
        logger.info(`[RetryService] SMS intent ${notif.id} handed to the notification outbox (row ${queued.outboxId}); not delivered — no SMS gateway is configured`);
      }
    } catch (err) {
      const newRetry = notif.retry_count + 1;
      const backoffMinutes = Math.pow(2, newRetry) * 5; // 10, 20, 40 minutes

      if (newRetry >= notif.max_retries) {
        await query(
          `UPDATE failed_notifications
           SET status='failed_permanent', retry_count=$1, error_message=$2, last_retry_at=NOW()
           WHERE id=$3`,
          [newRetry, err.message, notif.id]
        );
        logger.warn(`[RetryService] Notification ${notif.id} permanently failed after ${newRetry} retries`);
      } else {
        await query(
          `UPDATE failed_notifications
           SET retry_count=$1,
               next_retry_at=NOW() + ($2::int * INTERVAL '1 minute'),
               error_message=$3,
               last_retry_at=NOW()
           WHERE id=$4`,
          [newRetry, backoffMinutes, err.message, notif.id]
        );
        logger.info(`[RetryService] Notification ${notif.id} retry ${newRetry}/${notif.max_retries}, next in ${backoffMinutes}min`);
      }
    }
  }
}
