// src/services/appointment/waitTimeService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';

export async function estimateWaitTime(doctorId, date) {
  const rows = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('CONFIRMED', 'SCHEDULED'))::int AS waiting,
      COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int               AS in_progress,
      AVG(
        EXTRACT(EPOCH FROM (completed_at - started_at)) / 60
      ) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) AS avg_consult_minutes
    FROM appointments
    WHERE doctor_id = ${parseInt(doctorId)} AND DATE(appointment_date) = ${date}::date
  `;

  const stats = rows[0];
  const avgMinutes = parseFloat(stats.avg_consult_minutes) || 15;
  const waitMinutes = Math.round(parseInt(stats.waiting || 0) * avgMinutes);

  return {
    patientsAhead: parseInt(stats.waiting || 0),
    currentlyConsulting: parseInt(stats.in_progress || 0),
    estimatedWaitMinutes: waitMinutes,
    avgConsultationMinutes: Math.round(avgMinutes),
  };
}

export async function getPatientQueuePosition(appointmentId) {
  const rows = await prisma.$queryRaw`
    WITH apt AS (
      SELECT doctor_id, appointment_date, token_number, status
      FROM appointments WHERE id = ${parseInt(appointmentId)}
    )
    SELECT COUNT(*)::int AS position
    FROM appointments a, apt
    WHERE a.doctor_id = apt.doctor_id
      AND DATE(a.appointment_date) = DATE(apt.appointment_date)
      AND a.token_number < apt.token_number
      AND a.status IN ('CONFIRMED', 'SCHEDULED')
  `;

  return parseInt(rows[0]?.position || 0);
}

export async function getAppointmentWaitTime(appointmentId) {
  const rows = await prisma.$queryRaw`
    SELECT id, doctor_id, appointment_date, token_number, status
    FROM appointments WHERE id = ${parseInt(appointmentId)}
  `;

  if (rows.length === 0) return null;

  const apt = rows[0];
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

/**
 * Fetch every still-waiting appointment for a doctor on a given date
 * with each patient's current queue position + ETA. Used by the realtime
 * fan-out to push queue-position updates after a status change.
 */
export async function getWaitingQueueForDoctor(doctorId, date) {
  const rows = await prisma.$queryRaw`
    WITH waiting AS (
      SELECT id, patient_id, token_number
      FROM appointments
      WHERE doctor_id = ${parseInt(doctorId)}
        AND DATE(appointment_date) = ${date}::date
        AND status IN ('CONFIRMED', 'SCHEDULED')
    ),
    consult AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)
          FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) AS avg_min
      FROM appointments
      WHERE doctor_id = ${parseInt(doctorId)}
        AND DATE(appointment_date) = ${date}::date
    )
    SELECT w.id, w.patient_id, w.token_number,
           (SELECT COUNT(*) FROM waiting w2 WHERE w2.token_number < w.token_number)::int AS position,
           c.avg_min
    FROM waiting w, consult c
    ORDER BY w.token_number ASC
  `;

  return rows.map((r) => {
    const avgMin = parseFloat(r.avg_min) || 15;
    return {
      appointmentId: r.id,
      patientId: r.patient_id,
      tokenNumber: r.token_number,
      position: r.position,
      etaMinutes: Math.round(r.position * avgMin),
    };
  });
}
