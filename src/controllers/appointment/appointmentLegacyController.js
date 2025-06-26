import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { combineDateAndTime } from '../../utils/appointment/dateTimeUtils.js';

// Legacy appointment creation (backward compatibility)
export const createLegacyAppointment = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { doctor_name, date, time, department } = req.body;

    const result = await db.query(
      'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone, doctor_name, date, time]
    );

    const appointment = result.rows[0];
    const scheduledAt = combineDateAndTime(appointment.date, appointment.time);

    success(res, {
      id: appointment.id,
      doctor: appointment.doctor_name,
      department: department || null,
      scheduled_at: scheduledAt.toISOString(),
      booked_by: req.user?.name
    }, RESPONSE_MESSAGES.APPOINTMENT_BOOKED);
  } catch (err) {
    logger.error('Legacy appointment creation error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};

// Get appointments by phone (legacy)
export const getAppointmentsByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    
    // Check permissions
    if (req.user?.role === 'PATIENT' && req.user.phone !== phone) {
      return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
    }
    
    const result = await db.query(`
      SELECT a.*, d.name as doctor_name, dp.department, dp.specialization
      FROM appointments a
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      LEFT JOIN users p ON a.patient_id = p.id
      WHERE p.phone = $1 
      ORDER BY a.appointment_date DESC
    `, [phone]);
    
    success(res, result.rows, 'Appointments fetched successfully');
  } catch (err) {
    logger.error('Error fetching appointments by phone:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};

// Get appointments by UID (legacy)
export const getAppointmentsByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    
    const result = await db.query(`
      SELECT a.*, d.name as doctor_name, dp.department, dp.specialization
      FROM appointments a
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE a.uid = $1
      ORDER BY a.appointment_date DESC
    `, [uid]);
    
    if (result.rows.length === 0) {
      return error(res, 'No appointments found for this UID', HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, result.rows, 'Appointments fetched successfully');
  } catch (err) {
    logger.error('Error fetching appointments by UID:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};