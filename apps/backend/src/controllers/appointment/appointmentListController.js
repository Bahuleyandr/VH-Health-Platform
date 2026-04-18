import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
import { success, error } from '../../utils/responseHelper.js';

export const listAppointments = async (req, res) => {
  try {
    // Check permissions
    if (!APPOINTMENT_CONFIG.PERMISSIONS.VIEW_ALL.includes(req.user?.role)) {
      return error(res, 'Insufficient permissions to view all appointments', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      status: req.query.status,
      doctor_id: req.query.doctor_id,
      patient_id: req.query.patient_id,
      date: req.query.date
    };

    const pagination = {
      page: parseInt(req.query.page) || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE,
      limit: parseInt(req.query.limit) || APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT
    };

    const result = await appointmentQueryService.getAppointments(
      filters,
      pagination,
      req.user?.role,
      req.user?.id
    );

    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, 'Appointments retrieved successfully');
  } catch (err) {
    logger.error('Error listing appointments:', err);
    error(res, 'Failed to retrieve appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const appointment = await appointmentQueryService.getAppointmentById(id);
    
    if (!appointment) {
      return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    }

    // Check access permissions
    if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
      return error(res, 'Access denied', HTTP_STATUS.FORBIDDEN);
    }
    if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
      return error(res, 'Access denied', HTTP_STATUS.FORBIDDEN);
    }

    success(res, {
      appointment,
      accessedBy: req.user?.name
    }, 'Appointment retrieved successfully');
  } catch (err) {
    logger.error('Error getting appointment:', err);
    error(res, 'Failed to retrieve appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDoctorAppointments = async (req, res) => {
  try {
    const { doctor_id } = req.params;
    
    // Check permissions
    if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(doctor_id)) {
      return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      status: req.query.status,
      date: req.query.date
    };

    const appointments = await appointmentQueryService.getDoctorAppointments(doctor_id, filters);

    success(res, {
      appointments,
      count: appointments.length,
      doctor_id,
      filters,
      requestedBy: req.user?.name
    }, 'Doctor appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting doctor appointments:', err);
    error(res, 'Failed to retrieve doctor appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPatientAppointments = async (req, res) => {
  try {
    const { patient_id } = req.params;
    
    // Check permissions
    if (req.user?.role === 'PATIENT' && req.user.id !== parseInt(patient_id)) {
      return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      status: req.query.status
    };

    const appointments = await appointmentQueryService.getPatientAppointments(patient_id, filters);

    success(res, {
      appointments,
      count: appointments.length,
      patient_id,
      filter: filters.status ? { status: filters.status } : null,
      requestedBy: req.user?.name
    }, 'Patient appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting patient appointments:', err);
    error(res, 'Failed to retrieve patient appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getTodayAppointments = async (req, res) => {
  try {
    // Check permissions
    if (!APPOINTMENT_CONFIG.PERMISSIONS.VIEW_TODAY.includes(req.user?.role)) {
      return error(res, 'Insufficient permissions to view today\'s appointments', HTTP_STATUS.FORBIDDEN);
    }

    const result = await appointmentQueryService.getTodayAppointments(
      req.user?.role,
      req.user?.id
    );

    success(res, {
      ...result,
      count: result.appointments.length,
      requestedBy: req.user?.name
    }, 'Today\'s appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting today appointments:', err);
    error(res, 'Failed to retrieve today\'s appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const testRoute = (req, res) => {
  success(res, {
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    user: req.user?.name || 'Unknown'
  }, 'Appointment routes working!');
};