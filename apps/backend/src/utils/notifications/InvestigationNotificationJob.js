// src/utils/notifications/InvestigationNotificationJob.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { queuePatientSms } from './smsOutbox.js';
import { sendPushNotification } from './sendPushNotification.js';
import { NotificationTemplates } from './templates.js';

export async function sendInvestigationNotifications() {
  logger.info('🔬 Sending investigation report notifications...');

  try {
    // Query completed investigations not yet notified, join users by patient_id for device_token
    const result = await prisma.$queryRawUnsafe(
      `SELECT i.id, i.test_name, i.patient_id,
              u.name, u.phone, u.device_token, u.id as user_id,
              u.tenant_id::text AS tenant_id
       FROM investigations i
       JOIN users u ON i.patient_id = u.id
       WHERE i.status IN ('completed', 'COMPLETED', 'result_ready')
         AND i.notified IS DISTINCT FROM true
       ORDER BY i.id DESC
       LIMIT 50`
    );

    for (const row of result) {
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

        // 2. SMS intent if phone available. No gateway is configured, so this
        // records a durable notification-outbox row rather than claiming a
        // send (audit 2026-08-09 finding F7).
        if (row.phone) {
          try {
            const smsIntent = await queuePatientSms({
              tenantId: row.tenant_id || null,
              recipientId: row.user_id || null,
              recipientPhone: row.phone,
              title: 'Investigation report ready',
              body: message,
              data: {
                type: 'investigation_result',
                investigation_id: String(row.id),
              },
              sourceEventKey: `investigation-report-ready:${row.id}`,
              templateVersion: 'sms.investigation_report_ready.v1',
              context: 'investigation-report-ready',
            });
            logger.info(
              `📱 SMS intent ${smsIntent.queued ? 'queued' : 'NOT queued'} for investigation ID ${row.id}`
              + ` to ${maskPhoneForLog(row.phone)}${smsIntent.reason ? ` (${smsIntent.reason})` : ''}`,
            );
          } catch (smsErr) {
            logger.error(`❌ SMS queue failed for investigation ${row.id}: ${smsErr.message}`);
          }
        }

        // 3. In-app notification
        await prisma.$queryRawUnsafe(
          `INSERT INTO notifications (phone, title, body, type, user_id, created_at, updated_at, is_read)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), false)`,
          row.phone || 'unknown', 'Investigation Report Ready', message, 'investigation', row.user_id || null
        );

        // 4. Mark as notified
        await prisma.$queryRawUnsafe(
          `UPDATE investigations SET notified = true, notified_at = NOW(), patient_notified_at = NOW() WHERE id = $1`,
          row.id
        );

        logger.info(`✅ Notification logged for investigation ID ${row.id}`);
      } catch (err) {
        logger.error(`❌ Failed to process investigation notification for ID ${row.id}: ${err.message}`);
      }
    }

    if (result.length > 0) {
      logger.info(`🔬 Processed ${result.length} investigation notifications`);
    }
  } catch (err) {
    logger.error('Error during investigation notifications:', err.message || err);
  }
}
