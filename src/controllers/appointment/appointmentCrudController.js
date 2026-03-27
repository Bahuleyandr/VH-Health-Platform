import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import { checkAppointmentPermission } from '../../utils/appointment/appointmentHelpers.js';
import { success, error } from '../../utils/responseHelper.js';

export const createAppointment = async (req, res) => {
  try {
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
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          message: 'Time slot already booked',
          conflicting_appointment_id: validation.conflict.id
        });
      }
      return error(res, validation.errors.join(', '), HTTP_STATUS.BAD_REQUEST);
    }

    // Create the appointment
    const appointment = await appointmentService.createAppointment(appointmentData);

    success(res, {
      appointment,
      patient_name: validation.patient.name,
      doctor_name: validation.doctor.name,
      booked_by: req.user?.name
    }, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_BOOKED, HTTP_STATUS.CREATED);
  } catch (err) {
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
        return res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          message: 'Time slot already booked',
          conflicting_appointment_id: validation.conflict.id
        });
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