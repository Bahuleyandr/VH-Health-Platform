import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import { checkAppointmentPermission } from '../../utils/appointment/appointmentHelpers.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

async function resolveOrCreatePatientFromPhone({ patientPhone, patientName }) {
  const normalizedPhone = normalizePhone(patientPhone);
  if (!normalizedPhone) {
    const err = new Error('Valid patient phone is required');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  const last10 = normalizedPhone.replace(/\D/g, '').slice(-10);
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, uid, phone, name, role
       FROM users
      WHERE phone = $1 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $2
      ORDER BY CASE WHEN phone = $1 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
      LIMIT 1`,
    normalizedPhone,
    `%${last10}`,
  );

  if (existing.length > 0) {
    if (existing[0].role !== 'PATIENT') {
      const err = new Error('This phone number belongs to a non-patient account');
      err.statusCode = HTTP_STATUS.CONFLICT;
      throw err;
    }
    return { patient: existing[0], created: false };
  }

  const name = (patientName || '').trim() || 'New Patient';
  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, name, role, registered_at, updated_at)
     VALUES ($1, $2, 'PATIENT', NOW(), NOW())
     RETURNING id, uid, phone, name`,
    normalizedPhone,
    name,
  );

  return { patient: created[0], created: true };
}

export const createAppointment = async (req, res) => {
  try {
    let resolvedPatient = null;
    let createdNewPatient = false;
    if (!req.body.patient_id && req.body.patient_phone) {
      const resolved = await resolveOrCreatePatientFromPhone({
        patientPhone: req.body.patient_phone,
        patientName: req.body.patient_name,
      });
      resolvedPatient = resolved.patient;
      createdNewPatient = resolved.created;
      req.body.patient_id = resolved.patient.id;
    }

    const appointmentData = {
      patient_id: req.body.patient_id,
      doctor_id: req.body.doctor_id,
      appointment_date: req.body.appointment_date,
      appointment_time: req.body.appointment_time,
      reason: req.body.reason,
      notes: req.body.notes || null
    };

    // Validate the booking request
    const validation = await appointmentValidationService.validateBookingRequest(
      appointmentData,
      req.user
    );

    if (!validation.valid) {
      if (validation.conflict) {
        return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: validation.conflict.id });
      }
      return error(res, validation.errors.join(', '), HTTP_STATUS.BAD_REQUEST);
    }

    // Create the appointment (uses transaction with row-level locking to prevent double-booking)
    const appointment = await appointmentService.createAppointment(appointmentData);

    success(res, {
      appointment,
      patient_name: validation.patient.name ?? resolvedPatient?.name,
      patient: {
        id: validation.patient.id ?? resolvedPatient?.id,
        uid: validation.patient.uid ?? resolvedPatient?.uid,
        name: validation.patient.name ?? resolvedPatient?.name,
        phone: validation.patient.phone ?? resolvedPatient?.phone,
        created: createdNewPatient,
      },
      doctor_name: validation.doctor.name,
      booked_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_BOOKED, HTTP_STATUS.CREATED);
  } catch (err) {
    if (err.statusCode) {
      return error(res, err.message, err.statusCode);
    }
    if (err.isConflict) {
      return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: err.conflictingId });
    }
    logger.error('Error creating appointment:', err);
    error(res, 'Failed to book appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {
      appointment_date: req.body.appointment_date,
      appointment_time: req.body.appointment_time,
      reason: req.body.reason,
      notes: req.body.notes
    };

    // P1 IDOR: Verify the authenticated user owns/can access this appointment
    const appointment = await appointmentService.getAppointmentById(id);
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (!checkAppointmentPermission(req.user, appointment, 'update')) {
      return error(res, 'Insufficient permissions to update this appointment', HTTP_STATUS.FORBIDDEN);
    }

    // Validate the update request
    const validation = await appointmentValidationService.validateUpdateRequest(
      id,
      updateData,
      req.user
    );

    if (!validation.valid) {
      if (validation.conflict) {
        return error(res, 'Time slot already booked', HTTP_STATUS.CONFLICT, { conflicting_appointment_id: validation.conflict.id });
      }
      return error(res, validation.errors.join(', '), HTTP_STATUS.BAD_REQUEST);
    }

    // Update the appointment
    const updatedAppointment = await appointmentService.updateAppointment(id, updateData);

    success(res, {
      appointment: updatedAppointment,
      updated_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_UPDATED);
  } catch (err) {
    logger.error('Error updating appointment:', err);
    error(res, 'Failed to update appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deleteAppointment = async (req, res) => {
  try {
    const { id } = req.params;

    // Get appointment to check permissions
    const appointment = await appointmentService.getAppointmentById(id);
    
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    // Check permissions
    if (!checkAppointmentPermission(req.user, appointment, 'cancel')) {
      return error(res, 'Insufficient permissions to cancel this appointment', HTTP_STATUS.FORBIDDEN);
    }

    // Cancel the appointment
    const cancelledAppointment = await appointmentService.cancelAppointment(
      id,
      req.user?.name || 'User'
    );

    success(res, {
      appointment: cancelledAppointment,
      cancelled_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_CANCELLED);
  } catch (err) {
    logger.error('Error cancelling appointment:', err);
    error(res, 'Failed to cancel appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
