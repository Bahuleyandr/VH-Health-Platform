import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export async function estimateWaitTime(doctorId, date) {
  // Count patients ahead in queue (status = CONFIRMED or IN_PROGRESS)
  const result = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('CONFIRMED', 'SCHEDULED')) as waiting,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') as in_progress,
      AVG(EXTRACT(EPOCH FROM (completed_at - started_at))/60) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) as avg_consult_minutes
    FROM appointments
    WHERE doctor_id = $1 AND DATE(appointment_date) = $2
  `, [doctorId, date]);

  const stats = result.rows[0];
  const avgMinutes = parseFloat(stats.avg_consult_minutes) || 15; // default 15 min
  const waitMinutes = Math.round(parseInt(stats.waiting || 0) * avgMinutes);

  return {
    patientsAhead: parseInt(stats.waiting || 0),
    currentlyConsulting: parseInt(stats.in_progress || 0),
    estimatedWaitMinutes: waitMinutes,
    avgConsultationMinutes: Math.round(avgMinutes),
  };
}

export async function getPatientQueuePosition(appointmentId) {
  const result = await db.query(`
    WITH apt AS (
      SELECT doctor_id, appointment_date, token_number, status
      FROM appointments WHERE id = $1
    )
    SELECT
      COUNT(*) as position
    FROM appointments a, apt
    WHERE a.doctor_id = apt.doctor_id
      AND DATE(a.appointment_date) = DATE(apt.appointment_date)
      AND a.token_number < apt.token_number
      AND a.status IN ('CONFIRMED', 'SCHEDULED')
  `, [appointmentId]);

  return parseInt(result.rows[0]?.position || 0);
}

export async function getAppointmentWaitTime(appointmentId) {
  // First get the appointment details
  const aptResult = await db.query(`
    SELECT id, doctor_id, appointment_date, token_number, status
    FROM appointments WHERE id = $1
  `, [appointmentId]);

  if (aptResult.rows.length === 0) {
    return null;
  }

  const apt = aptResult.rows[0];
  const date = new Date(apt.appointment_date).toISOString().split('T')[0];

  const position = await getPatientQueuePosition(appointmentId);
  const estimate = await estimateWaitTime(apt.doctor_id, date);

  return {
    appointmentId: apt.id,
    status: apt.status,
    tokenNumber: apt.token_number,
    queuePosition: position,
    patientsAhead: position,
    currentlyConsulting: estimate.currentlyConsulting,
    estimatedWaitMinutes: Math.round(position * estimate.avgConsultationMinutes),
    avgConsultationMinutes: estimate.avgConsultationMinutes,
  };
}
