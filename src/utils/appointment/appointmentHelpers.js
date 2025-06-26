import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';

export const hasPermission = (userRole, action) => {
  const allowedRoles = APPOINTMENT_CONFIG.PERMISSIONS[action];
  return allowedRoles && allowedRoles.includes(userRole);
};

export const canAccessAppointment = (user, appointment) => {
  if (user.role === 'ADMIN' || user.role === 'NURSE') {
    return true;
  }
  if (user.role === 'DOCTOR' && appointment.doctor_id === user.id) {
    return true;
  }
  if (user.role === 'PATIENT' && appointment.patient_id === user.id) {
    return true;
  }
  return false;
};

export const buildPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page * limit < total,
    hasPrev: page > 1
  };
};

export const normalizeStatus = (status) => {
  return status ? status.toUpperCase() : null;
};