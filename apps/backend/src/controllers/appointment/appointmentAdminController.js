// src/controllers/appointment/appointmentAdminController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Appointment SLA & workflow dashboard for admin
 */
export const getAppointmentSLADashboard = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    // NOTE: All COUNT(*) are cast to ::int to avoid BigInt serialization issues in Prisma.
    // All date params use ::date cast because Prisma sends strings and Postgres needs explicit cast.
    const [volumeRes, slaRes, statusRes, deptRes, pendingRes] = await Promise.all([
      // Total volume
      prisma.$queryRawUnsafe(`SELECT
        COUNT(*)::int as total,
        COUNT(CASE WHEN status='CONFIRMED' THEN 1 END)::int as confirmed,
        COUNT(CASE WHEN status='COMPLETED' THEN 1 END)::int as completed,
        COUNT(CASE WHEN status='CANCELLED' THEN 1 END)::int as cancelled,
        COUNT(CASE WHEN status='NO_SHOW' THEN 1 END)::int as no_show,
        COUNT(CASE WHEN status='SCHEDULED' AND confirmed_at IS NULL THEN 1 END)::int as pending_confirmation
        FROM appointments WHERE DATE(appointment_date) BETWEEN $1::date AND $2::date`, from, to),

      // SLA metrics — appointments table uses `confirmed_at` for the
      // first-contact / acknowledgement timestamp (the legacy
      // `first_contact_at` column was dropped during the appointment
      // lifecycle rename; this query was never updated).
      prisma.$queryRawUnsafe(`SELECT
        COUNT(*)::int as total_with_sla,
        COUNT(CASE WHEN confirmed_at <= sla_target_at THEN 1 END)::int as within_sla,
        COUNT(CASE WHEN confirmed_at > sla_target_at THEN 1 END)::int as breached_sla,
        ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(confirmed_at, NOW()) - created_at))/60)::numeric, 1) as avg_response_minutes
        FROM appointments WHERE created_at >= NOW() - INTERVAL '7 days' AND sla_target_at IS NOT NULL`),

      // Status breakdown
      prisma.$queryRawUnsafe(`SELECT status, COUNT(*)::int as count FROM appointments
        WHERE DATE(appointment_date) BETWEEN $1::date AND $2::date GROUP BY status ORDER BY count DESC`, from, to),

      // By department
      prisma.$queryRawUnsafe(`SELECT COALESCE(a.department, doc.department, 'Unknown') as department,
        COUNT(*)::int as total,
        COUNT(CASE WHEN a.status='COMPLETED' THEN 1 END)::int as completed,
        COUNT(CASE WHEN a.status='CONFIRMED' THEN 1 END)::int as confirmed,
        COUNT(CASE WHEN a.status='CANCELLED' THEN 1 END)::int as cancelled
        FROM appointments a LEFT JOIN doctors doc ON doc.user_id=a.doctor_id
        WHERE DATE(a.appointment_date) BETWEEN $1::date AND $2::date
        GROUP BY COALESCE(a.department, doc.department, 'Unknown') ORDER BY total DESC`, from, to),

      // Pending confirmation (oldest first, limit 20)
      prisma.$queryRawUnsafe(`SELECT a.id, a.uid, a.status, a.appointment_date, a.appointment_time, a.created_at,
        p.name as patient_name, p.phone as patient_phone, d.name as doctor_name,
        ROUND(EXTRACT(EPOCH FROM (NOW()-a.created_at))/60)::int as mins_waiting,
        CASE WHEN a.sla_target_at IS NOT NULL AND NOW() > a.sla_target_at THEN TRUE ELSE FALSE END as sla_breached
        FROM appointments a
        LEFT JOIN users p ON a.patient_id=p.id
        LEFT JOIN users d ON a.doctor_id=d.id
        WHERE a.status='SCHEDULED' AND a.confirmed_at IS NULL
        ORDER BY a.created_at ASC LIMIT 20`),
    ]);

    success(res, {
      summary: volumeRes[0],
      sla: slaRes[0],
      by_status: statusRes,
      by_department: deptRes,
      pending_confirmation: pendingRes,
      date_range: { from, to },
    }, 'Appointment SLA dashboard fetched');
  } catch (err) {
    logger.error('Appointment SLA Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Full appointment audit trail (status history)
 */
export const getStatusAuditTrail = async (req, res) => {
  try {
    const { from_date, to_date, limit = 100, offset = 0 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (from_date) { params.push(from_date); where += ` AND DATE(ash.created_at) >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND DATE(ash.created_at) <= $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const result = await prisma.$queryRawUnsafe(`
      SELECT ash.*,
        a.uid as appointment_uid,
        p.name as patient_name,
        u.name as changed_by_name
      FROM appointment_status_history ash
      JOIN appointments a ON ash.appointment_id = a.id
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users u ON ash.changed_by = u.id
      ${where}
      ORDER BY ash.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);

    success(res, result, 'Audit trail fetched');
  } catch (err) {
    logger.error('Audit Trail Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
