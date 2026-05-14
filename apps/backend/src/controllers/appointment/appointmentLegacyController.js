import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { combineDateAndTime } from '../../utils/appointment/dateTimeUtils.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Legacy appointment creation (backward compatibility)
export const createLegacyAppointment = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { doctor_name, date, time, department } = req.body;

    // appointments.updated_at is NOT NULL with no DEFAULT — the legacy
    // INSERT above used to omit it and Postgres rejected the row with a
    // generic 500. Explicitly set updated_at = NOW() so the discharge
    // follow-up booking path stops failing with "Database error". Finding:
    // 2026-05-09-inpatient-admission-discharge-followup-api-500.
    const result = await prisma.$queryRawUnsafe(
      'INSERT INTO appointments (phone, doctor_name, appointment_date, appointment_time, updated_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, uid, phone, patient_name, doctor_name, appointment_date, appointment_time, status, created_at',
      phone, doctor_name, date, time
    );

    const appointment = result[0];
    const scheduledAt = combineDateAndTime(appointment.appointment_date, appointment.appointment_time);

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
    
    const result = await prisma.$queryRawUnsafe(`
      SELECT a.*, d.name as doctor_name, dp.department, dp.specialty
      FROM appointments a
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      LEFT JOIN users p ON a.patient_id = p.id
      WHERE p.phone = $1 
      ORDER BY a.appointment_date DESC
    `, phone);

    success(res, result, 'Appointments fetched successfully');
  } catch (err) {
    logger.error('Error fetching appointments by phone:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Get appointments by UID (legacy)
export const getAppointmentsByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid || !UUID_RE.test(String(uid).trim())) {
      return error(res, 'Invalid patient UID', HTTP_STATUS.BAD_REQUEST);
    }

    // `uid` is the patient's user UID (Firebase auth `sub`), not the
    // appointment's own row UID. Earlier WHERE a.uid = $1 matched the
    // appointment's primary uid and so always returned [] for patients
    // (and for follow-up appointments whose own `uid` is NULL).
    const result = await prisma.$queryRawUnsafe(`
      SELECT a.*, d.name as doctor_name, dp.department, dp.specialty
      FROM appointments a
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      JOIN users p ON a.patient_id = p.id
      WHERE p.uid = $1::uuid
      ORDER BY a.appointment_date DESC
    `, String(uid).trim().toLowerCase());

    // An empty result is not a "not found" — the user just has no
    // appointments. Return 200 with [] so the dashboard smart-polling
    // doesn't treat an empty list as a transient failure to retry.
    success(res, result, 'Appointments fetched successfully');
  } catch (err) {
    logger.error('Error fetching appointments by UID:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};