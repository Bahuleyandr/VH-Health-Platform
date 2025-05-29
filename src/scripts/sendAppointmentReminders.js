import pool from '../db.js';
import logger from '../logging/logger.js';
import { sendPushNotification } from '../utils/firebasePushHelper.js';

const sendAppointmentReminders = async () => {
  try {
    const today = new Date();
    const yyyyMMdd = today.toISOString().split('T')[0];

    const { rows: appointments } = await pool.query(`
      SELECT a.phone, a.id, a.appointment_date, u.name
      FROM appointments a
      JOIN users u ON u.phone = a.phone
      WHERE DATE(a.appointment_date) = $1
    `, [yyyyMMdd]);

    for (const appointment of appointments) {
      const { rows: devices } = await pool.query(
        `SELECT token FROM devices WHERE phone = $1`,
        [appointment.phone]
      );

      for (const device of devices) {
        await sendPushNotification({
          token: device.token,
          title: 'Appointment Reminder',
          body: `Hi ${appointment.name}, you have an appointment today.`,
          data: {
            type: 'appointment',
            appointmentId: appointment.id,
          },
        });
      }

      logger.info(`[Reminder] Sent appointment notification to ${appointment.phone}`);
    }

    logger.info(`✅ Appointment reminders sent for ${appointments.length} user(s).`);
  } catch (err) {
    logger.error('❌ Error sending appointment reminders:', err);
  }
};

sendAppointmentReminders();
