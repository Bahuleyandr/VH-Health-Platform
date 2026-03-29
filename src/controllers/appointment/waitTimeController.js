import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { estimateWaitTime, getAppointmentWaitTime } from '../../services/appointment/waitTimeService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * GET /appointments/:id/wait-time
 * Returns wait time estimate for a specific appointment.
 */
export const getWaitTimeForAppointment = async (req, res) => {
  try {
    const appointmentId = parseInt(req.params.id);
    if (isNaN(appointmentId)) {
      return error(res, 'Invalid appointment ID', HTTP_STATUS.BAD_REQUEST);
    }

    const waitData = await getAppointmentWaitTime(appointmentId);
    if (!waitData) {
      return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, waitData, 'Wait time estimate retrieved');
  } catch (err) {
    logger.error('Error fetching appointment wait time:', err);
    error(res, 'Failed to retrieve wait time estimate', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * GET /appointments/doctor/:doctorId/wait-time
 * Returns general wait time estimate for a doctor today.
 */
export const getWaitTimeForDoctor = async (req, res) => {
  try {
    const doctorId = parseInt(req.params.doctorId);
    if (isNaN(doctorId)) {
      return error(res, 'Invalid doctor ID', HTTP_STATUS.BAD_REQUEST);
    }

    const today = new Date().toISOString().split('T')[0];
    const waitData = await estimateWaitTime(doctorId, today);

    success(res, waitData, 'Doctor wait time estimate retrieved');
  } catch (err) {
    logger.error('Error fetching doctor wait time:', err);
    error(res, 'Failed to retrieve wait time estimate', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
