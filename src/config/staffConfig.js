// Staff role definitions
export const STAFF_ROLES = {
  ADMIN: 'ADMIN',
  DOCTOR: 'DOCTOR',
  NURSING_STAFF: 'NURSING_STAFF',
  PHARMACY_STAFF: 'PHARMACY_STAFF',
  LAB_STAFF: 'LAB_STAFF',
  HR_STAFF: 'HR_STAFF',
  GENERAL_STAFF: 'GENERAL_STAFF',
  RECEPTIONIST: 'RECEPTIONIST',
  SECURITY: 'SECURITY',
  MAINTENANCE: 'MAINTENANCE',
  EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER'
};

// Shift types and working hours
export const SHIFT_TYPES = {
  MORNING: { name: 'MORNING', start: '06:00', end: '14:00', duration: 8 },
  AFTERNOON: { name: 'AFTERNOON', start: '14:00', end: '22:00', duration: 8 },
  NIGHT: { name: 'NIGHT', start: '22:00', end: '06:00', duration: 8 },
  FULL_DAY: { name: 'FULL_DAY', start: '09:00', end: '17:00', duration: 8 },
  ON_CALL: { name: 'ON_CALL', start: 'flexible', end: 'flexible', duration: 0 }
};