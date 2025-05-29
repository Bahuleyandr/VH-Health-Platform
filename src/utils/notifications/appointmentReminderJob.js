import pool from '../../db.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from '../../services/firebasePush.js';
import { NotificationTemplates } from './templates.js';

export async function sendAppointmentReminders() {
  logger.info('📅 Sending appointment reminders for today...');

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const result = await pool.query(
      `SELECT a.id, a.uid, a.phone, a.appointment_date, a.doctor_id, u.device_token, u.name AS user_name,
              d.name AS doctor_name, dept.name AS department_name
       FROM appointments a
       JOIN users u ON a.uid = u.uid
       JOIN doctors d ON a.doctor_id = d.id
       JOIN departments dept ON d.department_id = dept.id
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
        await pool.query(
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
