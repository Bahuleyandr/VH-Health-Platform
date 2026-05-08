import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
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

    // Duplicate-detection guard: if this patient already has a SCHEDULED
    // appointment with the same doctor on the same date, surface a 409 with
    // the existing id unless the caller explicitly opts in via
    // `confirm_duplicate: true`. Receptionists can still book a second slot
    // (re-attempt after no-show, mid-day re-evaluation, etc.) but must
    // acknowledge it. See finding
    // 2026-05-08-follow-up-opd-receptionist-duplicate-appt-no-warning.
    if (
      appointmentData.patient_id &&
      appointmentData.doctor_id &&
      appointmentData.appointment_date &&
      req.body.confirm_duplicate !== true
    ) {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id, status, appointment_time
           FROM appointments
          WHERE patient_id = $1
            AND doctor_id = $2
            AND DATE(appointment_date) = $3::date
            AND status IN ('SCHEDULED', 'CONFIRMED')
          LIMIT 1`,
        appointmentData.patient_id,
        appointmentData.doctor_id,
        appointmentData.appointment_date,
      );
      if (existing.length > 0) {
        return error(
          res,
          'This patient already has an appointment with this doctor today. Pass `confirm_duplicate: true` to book a second slot.',
          HTTP_STATUS.CONFLICT,
          {
            code: 'DUPLICATE_APPOINTMENT_SAME_DAY',
            existing_appointment_id: existing[0].id,
            existing_appointment_status: existing[0].status,
            existing_appointment_time: existing[0].appointment_time,
          },
        );
      }
    }

    // Create the appointment (uses transaction with row-level locking to prevent double-booking)
    const appointment = await appointmentService.createAppointment(appointmentData);
    const hydratedAppointment =
      (await appointmentQueryService.getAppointmentById(appointment.id)) || appointment;

    success(res, {
      appointment: hydratedAppointment,
      patient_name: hydratedAppointment.patient_name ?? validation.patient.name ?? resolvedPatient?.name,
      patient: {
        id: validation.patient.id ?? resolvedPatient?.id,
        uid: validation.patient.uid ?? resolvedPatient?.uid,
        name: validation.patient.name ?? resolvedPatient?.name,
        phone: validation.patient.phone ?? resolvedPatient?.phone,
        created: createdNewPatient,
      },
      doctor_name: hydratedAppointment.doctor_name_detail ?? hydratedAppointment.doctor_name ?? validation.doctor.name,
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

    // Reject status updates explicitly — the previous handler silently
    // dropped `status` from the patch and returned 200, which made callers
    // believe the visit was closed when nothing changed. State transitions
    // belong on the dedicated sub-resources. See finding
    // 2026-05-08-follow-up-opd-doctor-status-update-silently-ignored.
    if (req.body.status !== undefined) {
      return error(
        res,
        'Status updates are not accepted on PUT /appointments/:id. Use POST /appointments/:id/{confirm|complete|cancel|no-show} or PUT /appointments/:id/status.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'STATUS_UPDATE_NOT_ALLOWED_HERE' },
      );
    }

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
