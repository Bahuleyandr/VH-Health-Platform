import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import appointmentValidationService from '../../services/appointment/appointmentValidationService.js';
import { success, error } from '../../utils/responseHelper.js';

export const updateAppointmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    // Validate status
    const statusValidation = appointmentValidationService.validateStatusUpdate(status);
    if (!statusValidation.valid) {
      return error(res, statusValidation.error, HTTP_STATUS.BAD_REQUEST);
    }

    // Get appointment to check permissions
    const appointment = await appointmentService.getAppointmentById(id);
    
    if (!appointment) {
      return error(res, APPOINTMENT_CONFIG.MESSAGES.APPOINTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    // Check permissions
    if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
      return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
    }
    if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
      return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
    }

    // Update status
    const updatedAppointment = await appointmentService.updateAppointmentStatus(
      id,
      statusValidation.status,
      notes,
      req.user?.name
    );

    success(res, {
      appointment: updatedAppointment,
      updated_by: req.user?.name
    }, 'Appointment status updated successfully');
  } catch (err) {
    logger.error('Error updating appointment status:', err);
    error(res, 'Failed to update appointment status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};