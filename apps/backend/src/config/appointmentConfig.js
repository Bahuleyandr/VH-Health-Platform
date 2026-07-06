// Appointment module configuration constants
export const APPOINTMENT_CONFIG = {
  STATUSES: {
    SCHEDULED: 'SCHEDULED',
    CONFIRMED: 'CONFIRMED',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    RESCHEDULED: 'RESCHEDULED',
    CANCELLED: 'CANCELLED',
    NO_SHOW: 'NO_SHOW'
  },
  
  DEFAULT_PAGINATION: {
    PAGE: 1,
    LIMIT: 10
  },
  
  DATE_FORMAT: 'DD-MM-YYYY',
  TIME_FORMAT: 'HH:mm',
  VISIT_TYPES: [
    'NEW',
    'FOLLOW_UP',
    'EMERGENCY',
    'TELE',
    'LAB_ONLY',
    'PAEDIATRIC_OPD',
  ],
  
  ROLES: {
    ADMIN: 'ADMIN',
    SUPER_ADMIN: 'SUPER_ADMIN',
    DOCTOR: 'DOCTOR',
    PATIENT: 'PATIENT',
    // The canonical role constant in roleHelpers.js + roles.js + the
    // user_role enum is NURSING_STAFF. The legacy 'NURSE' string lived
    // here from an early stub and never got reconciled — the result was
    // every NURSING_STAFF user got 403 INSUFFICIENT_PERMISSIONS on the
    // appointments / book / update / view-today flows because the
    // controller checked req.user.role against this list and the JWT
    // carries NURSING_STAFF, not NURSE. (The route-level RBAC at
    // rbacConfig.js correctly uses NURSING_STAFF; the drift was
    // controller-side.)
    NURSING_STAFF: 'NURSING_STAFF',
    RECEPTIONIST: 'RECEPTIONIST',
    RECEPTION_INCHARGE: 'RECEPTION_INCHARGE'
  },

  PERMISSIONS: {
    VIEW_ALL: [
      'ADMIN',
      'SUPER_ADMIN',
      'MEDICAL_SUPERINTENDENT',
      'CMO',
      'CNO',
      'NURSING_SUPERINTENDENT',
      'NURSING_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'DOCTOR',
      'NURSING_STAFF',
      'RECEPTIONIST',
      'RECEPTION_INCHARGE',
      'BILLING_STAFF',
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
      'ADMISSION_OFFICER',
      'INSURANCE_COORDINATOR',
      'IPD_COUNSELLOR'
    ],
    VIEW_TODAY: ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OP_STAFF_NURSE', 'OP_INCHARGE', 'RECEPTIONIST', 'RECEPTION_INCHARGE'],
    BOOK: ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OP_STAFF_NURSE', 'OP_INCHARGE', 'RECEPTIONIST', 'RECEPTION_INCHARGE', 'PATIENT'],
    UPDATE: ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'OP_STAFF_NURSE', 'OP_INCHARGE', 'RECEPTIONIST', 'RECEPTION_INCHARGE', 'PATIENT'],
    CANCEL: ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'OP_STAFF_NURSE', 'OP_INCHARGE', 'RECEPTIONIST', 'RECEPTION_INCHARGE', 'PATIENT']
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
           dp.specialty, dp.department
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id  
    LEFT JOIN doctors dp ON d.id = dp.user_id
  `,
  
  APPOINTMENT_DETAIL: `
    SELECT a.*, 
           p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
           d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
           dp.specialty, dp.department
    FROM appointments a
    LEFT JOIN users p ON a.patient_id = p.id
    LEFT JOIN users d ON a.doctor_id = d.id
    LEFT JOIN doctors dp ON d.id = dp.user_id
  `
};
