// src/services/notificationRetryService.js
// Self-healing notification retry — wraps push/SMS with automatic retry on failure

import db from '../config/database.js';
import logger from '../logging/logger.js';

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
      await db.query(`
        INSERT INTO failed_notifications (user_id, type, device_token, title, body, data, error_message)
        VALUES ($1, 'push', $2, $3, $4, $5, $6)
      `, [userId, deviceToken, payload.title, payload.body, JSON.stringify(payload.data || {}), err.message]);
    } catch (dbErr) {
      logger.error(`[RetryService] Failed to queue push retry: ${dbErr.message}`);
    }
  }
}

/**
 * Send SMS with automatic retry on failure.
 * On failure, queues to failed_notifications table for exponential backoff retry.
 */
export async function sendSMSWithRetry(phone, message, userId = null) {
  try {
    const { sendSMS } = await import('./smsService.js');
    await sendSMS(phone, message);
  } catch (err) {
    logger.warn(`[RetryService] SMS failed for ${phone}, queuing retry: ${err.message}`);
    try {
      await db.query(`
        INSERT INTO failed_notifications (user_id, type, phone, body, error_message)
        VALUES ($1, 'sms', $2, $3, $4)
      `, [userId, phone, message, err.message]);
    } catch (dbErr) {
      logger.error(`[RetryService] Failed to queue SMS retry: ${dbErr.message}`);
    }
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
    pending = await db.query(`
      SELECT * FROM failed_notifications
      WHERE status = 'pending' AND next_retry_at <= NOW() AND retry_count < max_retries
      ORDER BY created_at ASC LIMIT 50
    `);
  } catch (err) {
    logger.error(`[RetryService] Failed to query pending notifications: ${err.message}`);
    return;
  }

  if (pending.rows.length === 0) return;

  logger.info(`[RetryService] Processing ${pending.rows.length} failed notifications...`);

  for (const notif of pending.rows) {
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
        await db.query(`UPDATE failed_notifications SET status='sent' WHERE id=$1`, [notif.id]);
        logger.info(`[RetryService] Push retry succeeded for notification ${notif.id}`);
      } else if (notif.type === 'sms' && notif.phone) {
        const { sendSMS } = await import('./smsService.js');
        await sendSMS(notif.phone, notif.body);
        await db.query(`UPDATE failed_notifications SET status='sent' WHERE id=$1`, [notif.id]);
        logger.info(`[RetryService] SMS retry succeeded for notification ${notif.id}`);
      }
    } catch (err) {
      const newRetry = notif.retry_count + 1;
      const backoffMinutes = Math.pow(2, newRetry) * 5; // 10, 20, 40 minutes

      if (newRetry >= notif.max_retries) {
        await db.query(
          `UPDATE failed_notifications SET status='failed_permanent', retry_count=$1, error_message=$2 WHERE id=$3`,
          [newRetry, err.message, notif.id]
        );
        logger.warn(`[RetryService] Notification ${notif.id} permanently failed after ${newRetry} retries`);
      } else {
        await db.query(
          `UPDATE failed_notifications SET retry_count=$1, next_retry_at=NOW()+INTERVAL '${backoffMinutes} minutes', error_message=$2 WHERE id=$3`,
          [newRetry, err.message, notif.id]
        );
        logger.info(`[RetryService] Notification ${notif.id} retry ${newRetry}/${notif.max_retries}, next in ${backoffMinutes}min`);
      }
    }
  }
}
