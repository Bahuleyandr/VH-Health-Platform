import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from './sendPushNotification.js';
import { NotificationTemplates } from './templates.js';
import { sendAppointmentReminderSMS } from '../../services/smsService.js';

/**
 * Hourly 24h/1h SMS+push reminders for upcoming appointments
 * Called every hour from scheduler
 */
export async function sendTimedReminders() {
  const now = new Date();

  try {
    // 24h window: appointments between now+23h and now+24h
    const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 1h window: appointments between now+30min and now+90min
    const in30m = new Date(now.getTime() + 30 * 60 * 1000);
    const in90m = new Date(now.getTime() + 90 * 60 * 1000);

    const [res24h, res1h] = await Promise.all([
      db.query(`
        SELECT a.id, a.appointment_time, a.token_number,
               u.name AS patient_name, u.phone AS patient_phone, u.device_token,
               d.name AS doctor_name, doc.department
        FROM appointments a
        JOIN users u ON a.patient_id = u.id
        LEFT JOIN users d ON a.doctor_id = d.id
        LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
        WHERE a.status = 'CONFIRMED'
          AND a.appointment_date BETWEEN $1 AND $2
          AND a.reminder_24h_sent IS NOT TRUE
      `, [in23h, in24h]),
      db.query(`
        SELECT a.id, a.appointment_time, a.token_number,
               u.name AS patient_name, u.phone AS patient_phone, u.device_token,
               d.name AS doctor_name
        FROM appointments a
        JOIN users u ON a.patient_id = u.id
        LEFT JOIN users d ON a.doctor_id = d.id
        WHERE a.status = 'CONFIRMED'
          AND a.appointment_date BETWEEN $1 AND $2
          AND a.reminder_1h_sent IS NOT TRUE
      `, [in30m, in90m]),
    ]);

    // Send 24h reminders
    const sentIds24h = [];
    for (const appt of res24h.rows) {
      try {
        await sendAppointmentReminderSMS(
          appt.patient_phone, appt.patient_name, appt.doctor_name,
          appt.appointment_time, 24, appt.token_number
        );
        if (appt.device_token) {
          await sendPushNotification({
            tokens: appt.device_token,
            title: 'Appointment Tomorrow 📅',
            body: `Reminder: Your appointment is tomorrow at ${appt.appointment_time} with Dr. ${appt.doctor_name}. Token #${appt.token_number}`,
            data: { type: 'appointment_reminder_24h', appointment_id: String(appt.id) },
            userId: null,
          }).catch(e => logger.warn(`[Reminders] 24h push notification failed for appointment ${appt.id}:`, e.message));
        }
        sentIds24h.push(appt.id);
      } catch (e) {
        logger.warn(`[Reminders] 24h reminder failed for ${appt.id}: ${e.message}`);
      }
    }
    // Batch update all successfully sent 24h reminders
    if (sentIds24h.length > 0) {
      await db.query('UPDATE appointments SET reminder_24h_sent = TRUE WHERE id = ANY($1)', [sentIds24h]);
      logger.info(`[Reminders] Batch updated ${sentIds24h.length} appointments with 24h reminder sent`);
    }

    // Send 1h reminders
    const sentIds1h = [];
    for (const appt of res1h.rows) {
      try {
        await sendAppointmentReminderSMS(
          appt.patient_phone, appt.patient_name, appt.doctor_name,
          appt.appointment_time, 1, appt.token_number
        );
        if (appt.device_token) {
          await sendPushNotification({
            tokens: appt.device_token,
            title: 'Appointment in 1 Hour ⏰',
            body: `Your appointment at ${appt.appointment_time} with Dr. ${appt.doctor_name} is in ~1 hour. Token #${appt.token_number}`,
            data: { type: 'appointment_reminder_1h', appointment_id: String(appt.id) },
            userId: null,
          }).catch(e => logger.warn(`[Reminders] 1h push notification failed for appointment ${appt.id}:`, e.message));
        }
        sentIds1h.push(appt.id);
      } catch (e) {
        logger.warn(`[Reminders] 1h reminder failed for ${appt.id}: ${e.message}`);
      }
    }
    // Batch update all successfully sent 1h reminders
    if (sentIds1h.length > 0) {
      await db.query('UPDATE appointments SET reminder_1h_sent = TRUE WHERE id = ANY($1)', [sentIds1h]);
      logger.info(`[Reminders] Batch updated ${sentIds1h.length} appointments with 1h reminder sent`);
    }

    logger.info(`[Reminders] Done: ${res24h.rows.length} 24h + ${res1h.rows.length} 1h reminders sent`);
  } catch (err) {
    logger.error('[Reminders] sendTimedReminders error:', err.message);
  }
}

/**
 * Process pending scheduled notifications (feedback requests, etc.)
 * Called every 5 minutes from scheduler
 */
export async function processPendingScheduledNotifications() {
  try {
    const pending = await db.query(`
      SELECT sn.*, u.device_token, u.phone, u.name
      FROM scheduled_notifications sn
      JOIN users u ON sn.user_id = u.id
      WHERE sn.status = 'pending' AND sn.send_at <= NOW()
      ORDER BY sn.send_at
      LIMIT 50
    `);

    for (const notif of pending.rows) {
      try {
        if (notif.type === 'feedback_request' && notif.device_token) {
          const data = notif.data || {};
          await sendPushNotification({
            tokens: notif.device_token,
            title: 'How was your visit? ⭐',
            body: 'Please take a moment to rate your experience at Venkataeswara Hospitals.',
            data: {
              type: 'feedback_request',
              appointment_id: String(data.appointment_id || '')
            },
            userId: String(notif.user_id),
          }).catch(e => logger.warn(`[ScheduledNotif] Push notification failed for notif ${notif.id}:`, e.message));
        }
        await db.query(`UPDATE scheduled_notifications SET status='sent', sent_at=NOW() WHERE id=$1`, [notif.id]);
      } catch (e) {
        logger.warn(`[ScheduledNotif] Failed for notif ${notif.id}: ${e.message}`);
        await db.query(`UPDATE scheduled_notifications SET status='failed' WHERE id=$1`, [notif.id]).catch(e => logger.warn(`[ScheduledNotif] Failed to mark notification ${notif.id} as failed:`, e.message));
      }
    }

    if (pending.rows.length > 0) {
      logger.info(`[ScheduledNotif] Processed ${pending.rows.length} pending notifications`);
    }
  } catch (err) {
    logger.error('[ScheduledNotif] processPendingScheduledNotifications error:', err.message);
  }
}

export async function sendAppointmentReminders() {
  logger.info('📅 Sending appointment reminders for today...');

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const result = await db.query(
      `SELECT a.id, a.uid, a.phone, a.appointment_date, a.doctor_id, u.device_token, u.name AS user_name,
              du.name AS doctor_name, dept.name AS department_name
       FROM appointments a
       JOIN users u ON a.uid = u.uid
       JOIN users du ON a.doctor_id = du.id
       LEFT JOIN doctors doc ON doc.user_id = du.id
       LEFT JOIN departments dept ON doc.department_id = dept.id
       WHERE a.appointment_date >= $1 AND a.appointment_date < $2
         AND a.status != 'cancelled' AND u.device_token IS NOT NULL`,
      [today.toISOString(), tomorrow.toISOString()]
    );

    for (const appt of result.rows) {
      const appointmentDate = new Date(appt.appointment_date);
      const formattedDate = appointmentDate.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const formattedTime = appointmentDate.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit'
      });

      const body = NotificationTemplates.appointmentReminder({
        name: appt.user_name?.split(' ')[0] || 'Patient',
        date: formattedDate,
        time: formattedTime,
        department: appt.department_name,
        doctor: appt.doctor_name
      });

      const notification = {
        token: appt.device_token,
        title: 'Appointment Reminder',
        body,
        data: {
          type: 'appointment_reminder',
          appointmentId: appt.id.toString(),
          phone: appt.phone
        }
      };

      try {
        await sendPushNotification(notification.token, notification.title, notification.body, notification.data);
        logger.info(`✅ Reminder sent to ${appt.phone}`);

        // Store as in-app notification
        await db.query(
          `INSERT INTO notifications (phone, title, body, type, created_at, read)
           VALUES ($1, $2, $3, $4, NOW(), false)`,
          [appt.phone, notification.title, notification.body, 'reminder']
        );
      } catch (err) {
        logger.error(`❌ Failed to send reminder to ${appt.phone}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Error sending appointment reminders:', err);
  }
}
