import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
import { parseListQuery } from '../../utils/listQuery.js';
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
      date: req.query.date,
      search: req.query.search,
      // Admission-counter worklist: ?advised_for_admission=true returns
      // only appointments with a non-null advised_for_admission_at.
      advised_for_admission: req.query.advised_for_admission,
    };

    const pagination = parseListQuery(req.query, {
      defaultPage: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE,
      defaultLimit: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT,
      maxLimit: 100,
      defaultSortBy: 'appointment_date',
      allowedSortFields: [
        'appointment_date',
        'appointment_time',
        'created_at',
        'status',
        'patient',
        'doctor',
        'phone',
        'department',
        'token'
      ]
    });

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

export const getRecentCompletedAppointments = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        a.id,
        COALESCE(NULLIF(u.name, ''), NULLIF(a.patient_name, ''), a.phone, 'Unknown patient') AS patient_name,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        a.appointment_time
      FROM appointments a
      LEFT JOIN users u ON u.id = a.patient_id
      WHERE LOWER(a.status) IN ('completed', 'done')
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
      LIMIT $1::int
    `, limit);

    success(res, rows.map((row) => ({
      id: Number(row.id),
      patient_name: row.patient_name || 'Unknown patient',
      appointment_date: row.appointment_date,
      appointment_time: row.appointment_time,
    })), 'Completed appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting completed appointments:', err);
    error(res, 'Failed to retrieve completed appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
