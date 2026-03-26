// src/controllers/appointment/appointmentWorkflowController.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';

/**
 * Staff confirms an appointment — assigns token, sets confirmed_at, notifies patient
 */
export const confirmAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { confirmation_notes, appointment_date, appointment_time } = req.body;

    const appt = await db.query('SELECT * FROM appointments WHERE id=$1', [id]);
    if (!appt.rows.length) return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    const a = appt.rows[0];
    if (a.status === 'CANCELLED') return error(res, 'Cannot confirm a cancelled appointment', HTTP_STATUS.BAD_REQUEST);

    // Generate daily token — count confirmed appointments for that date
    const targetDate = appointment_date || a.appointment_date;
    const tokenQuery = await db.query(
      `SELECT COUNT(*)+1 as token FROM appointments WHERE DATE(appointment_date)=DATE($1) AND confirmed_at IS NOT NULL`,
      [targetDate]
    );
    const tokenNumber = parseInt(tokenQuery.rows[0].token);

    const newDate = appointment_date || a.appointment_date;
    const newTime = appointment_time || a.appointment_time;

    const result = await db.query(`
      UPDATE appointments SET
        status = 'CONFIRMED',
        confirmed_by = $1,
        confirmed_at = NOW(),
        confirmation_notes = $2,
        first_contact_at = COALESCE(first_contact_at, NOW()),
        token_number = $3,
        appointment_date = $4,
        appointment_time = $5,
        sla_target_at = COALESCE(sla_target_at, created_at + INTERVAL '30 minutes'),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [staffId, confirmation_notes || null, tokenNumber, newDate, newTime, id]);

    // Log status change
    await db.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
       VALUES ($1,$2,'CONFIRMED',$3,'staff',$4)`,
      [id, a.status, staffId, confirmation_notes || null]
    );

    // Notify patient via FCM
    const patient = await db.query('SELECT device_token, name FROM users WHERE id=$1', [a.patient_id]);
    if (patient.rows[0]?.device_token) {
      setImmediate(async () => {
        try {
          await sendPushNotification({
            tokens: patient.rows[0].device_token,
            title: 'Appointment Confirmed ✓',
            body: `Your appointment on ${new Date(newDate).toLocaleDateString('en-IN')} at ${newTime} is confirmed. Token #${tokenNumber}`,
            data: { type: 'appointment_confirmed', appointment_id: String(id), token: String(tokenNumber) },
            userId: String(a.patient_id),
          });
        } catch (e) { logger.warn('Appointment notification failed:', e.message); }
      });
    }

    success(res, result.rows[0], `Appointment confirmed. Token #${tokenNumber}`);
  } catch (err) {
    logger.error('Confirm Appointment Error:', err);
    error(res, err.message || 'Failed to confirm appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff marks appointment as no-show
 */
export const markNoShow = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const appt = await db.query('SELECT * FROM appointments WHERE id=$1', [id]);
    if (!appt.rows.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    const result = await db.query(
      `UPDATE appointments SET status='NO_SHOW', no_show_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id]
    );
    await db.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1,$2,'NO_SHOW',$3,'staff')`,
      [id, appt.rows[0].status, staffId]
    );
    success(res, result.rows[0], 'Marked as no-show');
  } catch (err) {
    logger.error('Mark No-Show Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff marks appointment as completed (patient visited)
 */
export const completeAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { notes } = req.body;
    const appt = await db.query('SELECT * FROM appointments WHERE id=$1', [id]);
    if (!appt.rows.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    const result = await db.query(
      `UPDATE appointments SET status='COMPLETED', completed_at=NOW(), notes=COALESCE($2, notes), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, notes || null]
    );
    await db.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1,$2,'COMPLETED',$3,'staff')`,
      [id, appt.rows[0].status, staffId]
    );
    success(res, result.rows[0], 'Appointment completed');
  } catch (err) {
    logger.error('Complete Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff/patient cancels appointment
 */
export const cancelAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.id;
    const { cancellation_reason } = req.body;
    const appt = await db.query('SELECT * FROM appointments WHERE id=$1', [id]);
    if (!appt.rows.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);

    const result = await db.query(
      `UPDATE appointments SET status='CANCELLED', cancellation_reason=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, cancellation_reason || null]
    );
    await db.query(
      `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, changed_by, changed_by_role, reason) VALUES ($1,$2,'CANCELLED',$3,'staff',$4)`,
      [id, appt.rows[0].status, staffId, cancellation_reason || null]
    );

    // Notify patient
    const patient = await db.query('SELECT device_token FROM users WHERE id=$1', [appt.rows[0].patient_id]);
    if (patient.rows[0]?.device_token) {
      setImmediate(async () => {
        try {
          await sendPushNotification({
            tokens: patient.rows[0].device_token,
            title: 'Appointment Cancelled',
            body: `Your appointment has been cancelled. ${cancellation_reason || 'Please rebook.'}`,
            data: { type: 'appointment_cancelled', appointment_id: String(id) },
            userId: String(appt.rows[0].patient_id),
          });
        } catch (e) { logger.warn('Cancel notification failed:', e.message); }
      });
    }

    success(res, result.rows[0], 'Appointment cancelled');
  } catch (err) {
    logger.error('Cancel Appointment Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get today's appointment queue for staff (sorted by token then time)
 */
export const getTodayQueue = async (req, res) => {
  try {
    const { doctor_id, department } = req.query;
    let where = `WHERE DATE(a.appointment_date) = CURRENT_DATE AND a.status NOT IN ('CANCELLED')`;
    const params = [];
    if (doctor_id) { params.push(doctor_id); where += ` AND a.doctor_id=$${params.length}`; }
    if (department) { params.push(department); where += ` AND a.department=$${params.length}`; }

    const result = await db.query(`
      SELECT a.*,
        p.name as patient_name, p.phone as patient_phone, p.blood_group,
        d.name as doctor_display_name, d.specialization,
        doc.department as doctor_department
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
      ${where}
      ORDER BY a.token_number NULLS LAST, a.appointment_time
    `, params);

    success(res, result.rows, "Today's queue fetched");
  } catch (err) {
    logger.error('Get Queue Error:', err);
    error(res, 'Failed to fetch queue', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get pending appointments (SCHEDULED, not yet confirmed)
 */
export const getPendingAppointments = async (req, res) => {
  try {
    const { from_date, to_date, doctor_id } = req.query;
    let where = `WHERE a.status = 'SCHEDULED'`;
    const params = [];
    if (from_date) { params.push(from_date); where += ` AND DATE(a.appointment_date) >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND DATE(a.appointment_date) <= $${params.length}`; }
    if (doctor_id) { params.push(doctor_id); where += ` AND a.doctor_id=$${params.length}`; }

    const result = await db.query(`
      SELECT a.*,
        p.name as patient_name, p.phone as patient_phone,
        d.name as doctor_name,
        EXTRACT(EPOCH FROM (NOW() - a.created_at))/60 as minutes_since_booking,
        CASE WHEN a.sla_target_at IS NOT NULL AND NOW() > a.sla_target_at THEN TRUE ELSE FALSE END as sla_breached
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      ${where}
      ORDER BY a.sla_target_at NULLS FIRST, a.created_at
    `, params);

    success(res, result.rows, 'Pending appointments fetched');
  } catch (err) {
    logger.error('Get Pending Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get appointment status history (audit trail)
 */
export const getAppointmentHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT ash.*, u.name as changed_by_name
      FROM appointment_status_history ash
      LEFT JOIN users u ON ash.changed_by = u.id
      WHERE ash.appointment_id = $1
      ORDER BY ash.created_at ASC
    `, [id]);
    success(res, result.rows, 'History fetched');
  } catch (err) {
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
