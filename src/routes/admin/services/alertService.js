// src/routes/admin/services/alertsService.js
import { tableExists, safeQuery, safeScalar } from './common.js';

export async function getSystemAlerts() {
  const alerts = [];

  // SOS spike alert
  if (await tableExists('sos_alerts')) {
    const sosLastHour = await safeScalar(
      `SELECT COUNT(*) FROM sos_alerts WHERE created_at >= NOW() - INTERVAL '1 hour'`
    );
    if (sosLastHour > 10) {
      alerts.push({
        type: 'warning',
        message: `High SOS alert rate: ${sosLastHour} in the last hour`,
        priority: 'high',
      });
    }
  }

  // Appointment conflicts + no-show rate alerts
  if (await tableExists('appointments')) {
    const conflicts = await safeQuery(
      `
      SELECT 1
      FROM appointments a1
      JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
      WHERE a1.id <> a2.id
        AND a1.status = 'scheduled'
        AND a2.status = 'scheduled'
        AND DATE(a1.appointment_date) = CURRENT_DATE
        AND a1.appointment_date < a2.appointment_date
        AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
      LIMIT 1
      `,
      [],
      'alerts.conflicts'
    );
    if (conflicts.length) {
      alerts.push({
        type: 'error',
        message: 'Appointment conflicts detected today',
        priority: 'urgent',
        action: '/api/v1/admin/appointments/conflicts',
      });
    }

    const total7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`
    );
    const noshows7 = await safeScalar(
      `SELECT COUNT(*) FROM appointments WHERE status = 'no_show' AND appointment_date >= CURRENT_DATE - INTERVAL '7 days' AND appointment_date < CURRENT_DATE`
    );
    if (total7 > 0) {
      const rate = (noshows7 / total7) * 100;
      if (rate > 15) {
        alerts.push({
          type: 'warning',
          message: `High no-show rate: ${rate.toFixed(1)}% in the last 7 days`,
          priority: 'medium',
          action: '/api/v1/admin/appointments/no-shows',
        });
      }
    }
  }

  // Attendance issues
  if ((await tableExists('staff')) && (await tableExists('staff_attendance'))) {
    const absent = await safeScalar(
      `
      SELECT COUNT(*) FROM staff s
      WHERE COALESCE(s.is_active, true) = true 
        AND COALESCE(s.on_leave, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM staff_attendance a 
          WHERE a.staff_id = s.id 
            AND a.check_in_time::date = CURRENT_DATE
        )
      `
    );
    if (absent > 5) {
      alerts.push({
        type: 'warning',
        message: `${absent} staff absent today without leave`,
        priority: 'medium',
        action: '/api/v1/staff/admin/attendance/absent-report',
      });
    }
  }

  return alerts;
}

export default { getSystemAlerts };
