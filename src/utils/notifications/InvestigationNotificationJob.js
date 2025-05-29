// src/utils/notifications/investigationNotificationJob.js

import pool from '../../db.js';
import logger from '../../logging/logger.js';
import { NotificationTemplates } from './templates.js';

export async function sendInvestigationNotifications() {
  logger.info('🔬 Sending investigation report notifications...');

  try {
    const result = await pool.query(
      `SELECT i.id, i.phone, i.test_name, u.name
       FROM investigations i
       JOIN users u ON i.phone = u.phone
       WHERE i.id IN (
         SELECT id FROM investigations
         WHERE notified IS DISTINCT FROM true
         ORDER BY id DESC
         LIMIT 50
       )`
    );

    for (const row of result.rows) {
      const message = NotificationTemplates.investigationReady({
        name: row.name,
        testName: row.test_name
      });

      try {
        await pool.query(
          `INSERT INTO notifications (phone, title, body, type, created_at, read)
           VALUES ($1, $2, $3, $4, NOW(), false)`,
          [row.phone, 'Investigation Report Ready', message, 'investigation']
        );

        await pool.query(
          `UPDATE investigations SET notified = true WHERE id = $1`,
          [row.id]
        );

        logger.info(`✅ Notification logged for investigation ID ${row.id}`);
      } catch (err) {
        logger.error(`❌ Failed to log investigation notification for ${row.phone}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Error during investigation notifications:', err.message || err);
  }
}
