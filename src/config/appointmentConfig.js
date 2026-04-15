// Appointment module configuration constants
export const APPOINTMENT_CONFIG = {
  STATUSES: {
    SCHEDULED: 'SCHEDULED',
    CONFIRMED: 'CONFIRMED',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    NO_SHOW: 'NO_SHOW'
  },
  
  DEFAULT_PAGINATION: {
    PAGE: 1,
    LIMIT: 10
  },
  
  DATE_FORMAT: 'DD-MM-YYYY',
  TIME_FORMAT: 'HH:mm',
  
  ROLES: {
    ADMIN: 'ADMIN',
    DOCTOR: 'DOCTOR',
    PATIENT: 'PATIENT',
    NURSE: 'NURSE',
    RECEPTIONIST: 'RECEPTIONIST'
  },
  
  PERMISSIONS: {
    VIEW_ALL: ['ADMIN', 'DOCTOR', 'NURSE'],
    VIEW_TODAY: ['ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'],
    BOOK: ['ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'PATIENT'],
    UPDATE: ['ADMIN', 'DOCTOR', 'NURSE', 'PATIENT'],
    CANCEL: ['ADMIN', 'DOCTOR', 'PATIENT']
  },
  
  MESSAGES: {
    APPOINTMENT_NOT_FOUND: 'Appointment not found',
    INSUFFICIENT_PERMISSIONS: 'Insufficient permissions',
    TIME_SLOT_BOOKED: 'Time slot already booked',
    INVALID_STATUS: 'Invalid appointment status',
    APPOINTMENT_BOOKED: 'Appointment booked successfully',
    APPOINTMENT_UPDATED: 'Appointment updated successfully',
    APPOINTMENT_CANCELLED: 'Appointment cancelled successfully'
  },

BUSINESS_HOURS: {
    START: '09:00',
    END: '18:00',
    BREAK_START: '13:00',
    BREAK_END: '14:00'
  },
  
  APPOINTMENT_DURATION: 30, // minutes
};

export const APPOINTMENT_QUERIES = {
  LIST_ALL: `
    SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
           a.created_at, a.updated_at,
           p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
           d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
           dp.specialization, dp.department
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id  
    LEFT JOIN doctors dp ON d.id = dp.user_id
  `,
  
  APPOINTMENT_DETAIL: `
    SELECT a.*, 
           p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
           d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
           dp.specialization, dp.department, dp.consultation_fee
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    LEFT JOIN doctors dp ON d.id = dp.user_id
  `
};