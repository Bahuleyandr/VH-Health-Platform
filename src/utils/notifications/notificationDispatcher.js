// src/utils/notifications/notificationDispatcher.js

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from './sendPushNotification.js';
import { sendEmail } from './sendEmailNotification.js';

/**
 * Unified notification dispatcher.
 * Each channel is best-effort — failures don't block other channels.
 *
 * @param {Object} options
 * @param {string} options.userId - User UID or phone for lookup
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {string[]} options.channels - Array of channels: 'push', 'email', 'inapp'
 * @param {Object} [options.data] - Extra data for push notifications
 * @param {string} [options.type] - Notification type for in-app storage
 */
export async function dispatch({ userId, title, body, channels = ['push', 'inapp'], data = {}, type = 'general' }) {
  const results = {};

  // Lookup user info
  let user = null;
  try {
    const res = await db.query(
      `SELECT uid, phone, email, name, device_token FROM users WHERE uid = $1 OR phone = $1 LIMIT 1`,
      [userId]
    );
    user = res.rows[0] || null;
  } catch (err) {
    logger.error(`Notification dispatch: failed to lookup user ${userId} — ${err.message}`);
    return results;
  }

  if (!user) {
    logger.warn(`Notification dispatch: user not found — ${userId}`);
    return results;
  }

  // Push notification
  if (channels.includes('push')) {
    try {
      if (user.device_token) {
        await sendPushNotification({
          tokens: user.device_token,
          title,
          body,
          data,
        });
        results.push = 'sent';
      } else {
        results.push = 'no_token';
      }
    } catch (err) {
      logger.error(`Notification dispatch [push] failed for ${userId}: ${err.message}`);
      results.push = 'error';
    }
  }

  // Email notification
  if (channels.includes('email')) {
    try {
      if (user.email) {
        await sendEmail({
          to: user.email,
          subject: title,
          text: body,
          html: `<p>${body}</p>`,
        });
        results.email = 'sent';
      } else {
        results.email = 'no_email';
      }
    } catch (err) {
      logger.error(`Notification dispatch [email] failed for ${userId}: ${err.message}`);
      results.email = 'error';
    }
  }

  // In-app notification
  if (channels.includes('inapp')) {
    try {
      await db.query(
        `INSERT INTO notifications (phone, title, body, type, created_at, read)
         VALUES ($1, $2, $3, $4, NOW(), false)`,
        [user.phone, title, body, type]
      );
      results.inapp = 'stored';
    } catch (err) {
      logger.error(`Notification dispatch [inapp] failed for ${userId}: ${err.message}`);
      results.inapp = 'error';
    }
  }

  return results;
}
