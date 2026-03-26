// src/utils/notifications/InvestigationNotificationJob.js

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from './sendPushNotification.js';
import { sendSMS } from '../../services/smsService.js';
import { NotificationTemplates } from './templates.js';

export async function sendInvestigationNotifications() {
  logger.info('🔬 Sending investigation report notifications...');

  try {
    // Query completed investigations not yet notified, join users by patient_id for device_token
    const result = await db.query(
      `SELECT i.id, i.test_name, i.patient_id,
              u.name, u.phone, u.device_token, u.id as user_id
       FROM investigations i
       JOIN users u ON i.patient_id = u.id
       WHERE i.status IN ('completed', 'COMPLETED', 'result_ready')
         AND i.notified IS DISTINCT FROM true
       ORDER BY i.id DESC
       LIMIT 50`
    );

    for (const row of result.rows) {
      const message = NotificationTemplates.investigationReady({
        name: row.name || 'Patient',
        testName: row.test_name
      });

      try {
        // 1. Push notification via FCM if device_token available
        if (row.device_token) {
          try {
            await sendPushNotification({
              tokens: row.device_token,
              title: 'Investigation Report Ready',
              body: message,
              data: { type: 'investigation_result', investigation_id: String(row.id) },
              userId: row.user_id ? String(row.user_id) : null
            });
            logger.info(`📨 Push sent for investigation ID ${row.id} to user ${row.user_id}`);
          } catch (pushErr) {
            logger.error(`❌ Push failed for investigation ${row.id}: ${pushErr.message}`);
          }
        }

        // 2. SMS notification if phone available
        if (row.phone) {
          try {
            await sendSMS(row.phone, message);
            logger.info(`📱 SMS sent for investigation ID ${row.id} to ${row.phone}`);
          } catch (smsErr) {
            logger.error(`❌ SMS failed for investigation ${row.id}: ${smsErr.message}`);
          }
        }

        // 3. In-app notification
        await db.query(
          `INSERT INTO notifications (phone, title, body, type, created_at, read)
           VALUES ($1, $2, $3, $4, NOW(), false)`,
          [row.phone || 'unknown', 'Investigation Report Ready', message, 'investigation']
        );

        // 4. Mark as notified
        await db.query(
          `UPDATE investigations SET notified = true, notified_at = NOW(), patient_notified_at = NOW() WHERE id = $1`,
          [row.id]
        );

        logger.info(`✅ Notification logged for investigation ID ${row.id}`);
      } catch (err) {
        logger.error(`❌ Failed to process investigation notification for ID ${row.id}: ${err.message}`);
      }
    }

    if (result.rows.length > 0) {
      logger.info(`🔬 Processed ${result.rows.length} investigation notifications`);
    }
  } catch (err) {
    logger.error('Error during investigation notifications:', err.message || err);
  }
}
