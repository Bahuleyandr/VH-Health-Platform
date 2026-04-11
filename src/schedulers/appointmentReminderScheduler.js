// src/schedulers/appointmentReminderScheduler.js
// Sends push notifications 24 hours before scheduled appointments.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { dispatch } from '../utils/notifications/notificationDispatcher.js';

/**
 * Fetches appointments in the next 24 hours that haven't been reminded yet,
 * sends push notifications, and marks them as reminded.
 *
 * Call from a cron job (e.g., every 30 minutes):
 *   import { runAppointmentReminders } from './schedulers/appointmentReminderScheduler.js';
 *   cron.schedule('0,30 * * * *', () => runAppointmentReminders());
 */
export async function runAppointmentReminders() {
  try {
    // Find appointments 24h ahead that haven't been reminded
    const upcoming = await prisma.$queryRawUnsafe(`
      SELECT a.id, a.patient_id, a.appointment_date, a.appointment_time,
             a.doctor_id, a.status, p.name AS patient_name, p.phone AS patient_phone,
             d.name AS doctor_name, dept.name AS department_name
      FROM appointments a
      JOIN users p ON a.patient_id = p.id
      JOIN doctors doc ON a.doctor_id = doc.id
      JOIN users d ON doc.user_id = d.id
      LEFT JOIN departments dept ON doc.department_id = dept.id
      WHERE a.appointment_date BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        AND a.status IN ('scheduled', 'confirmed')
        AND (a.reminder_sent IS NULL OR a.reminder_sent = false)
      ORDER BY a.appointment_date ASC
      LIMIT 100
    `);

    if (upcoming.length === 0) {
      logger.info('Appointment reminders: no upcoming appointments to remind');
      return { reminded: 0 };
    }

    let reminded = 0;

    for (const appt of upcoming) {
      try {
        // Send push notification
        await dispatch({
          type: 'APPOINTMENT_REMINDER',
          targetPhone: appt.patient_phone,
          title: 'Appointment Reminder',
          body: `You have an appointment with Dr. ${appt.doctor_name} (${appt.department_name || 'General'}) tomorrow at ${appt.appointment_time || 'your scheduled time'}.`,
          data: {
            route: '/appointments',
            appointment_id: String(appt.id),
          },
        });

        // Mark as reminded
        await prisma.$queryRawUnsafe(
          `UPDATE appointments SET reminder_sent = true WHERE id = $1`,
          appt.id
        );

        reminded++;
      } catch (err) {
        logger.error(`Failed to send reminder for appointment ${appt.id}:`, err.message);
      }
    }

    logger.info(`Appointment reminders: sent ${reminded}/${upcoming.length} reminders`);
    return { reminded, total: upcoming.length };
  } catch (err) {
    logger.error('Appointment reminder scheduler error:', err);
    return { reminded: 0, error: err.message };
  }
}
