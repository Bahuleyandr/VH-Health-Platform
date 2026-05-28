import { STAFF_ROLES } from '../../config/staffConfig.js';

// Get staff role hierarchy for access control.
//
// SUPER_ADMIN was missing from this map and silently fell back to the
// `[userRole]` branch — which returned `['SUPER_ADMIN']`. The Profile
// screen then 404'd because the only row matching `WHERE u.role = ANY(...)`
// would be a SUPER_ADMIN, and the JOIN to staff filtered it out unless the
// admin had a staff row. Treat SUPER_ADMIN as a strict superset of ADMIN
// (everything ADMIN can see plus other admins).
export function getStaffHierarchy(userRole) {
  const allStaffRoles = Object.values(STAFF_ROLES);
  // Anaesthetists are clinical-doctor tier (same level as DOCTOR for the
  // theatre/ICU/PACU surfaces); RADIOLOGY_STAFF mirrors LAB_STAFF as a
  // self-contained role bucket. HR_STAFF now lists every modality role
  // so HR can see/manage the full clinical roster, not just the
  // legacy DOCTOR / NURSING_STAFF / PHARMACY_STAFF / LAB_STAFF subset.
  // Finding H' D30.
  const hierarchy = {
    SUPER_ADMIN: [...allStaffRoles, 'SUPER_ADMIN'],
    ADMIN: allStaffRoles,
    HR_STAFF: [
      'HR_STAFF',
      'MEDICAL_SUPERINTENDENT',
      'CNO',
      'DOCTOR',
      'ANAESTHETIST',
      'DUTY_DOCTOR',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'PHARMACY_STAFF',
      'LAB_STAFF',
      'RADIOLOGY_STAFF',
      'GENERAL_STAFF',
      'HOUSEKEEPING_STAFF',
      'HOUSEKEEPING_INCHARGE',
      'RECEPTIONIST',
      'SECURITY',
      'MAINTENANCE'
    ],
    DOCTOR: ['DOCTOR', 'ANAESTHETIST', 'NURSING_STAFF'],
    ANAESTHETIST: ['ANAESTHETIST', 'NURSING_STAFF'],
    MEDICAL_SUPERINTENDENT: [
      'MEDICAL_SUPERINTENDENT',
      'DOCTOR',
      'DUTY_DOCTOR',
      'ANAESTHETIST',
      'NURSING_INCHARGE',
      'NURSING_STAFF',
      'OP_INCHARGE',
      'OP_STAFF_NURSE'
    ],
    CNO: ['CNO', 'NURSING_INCHARGE', 'NURSING_STAFF', 'OP_INCHARGE', 'OP_STAFF_NURSE'],
    NURSING_INCHARGE: ['NURSING_INCHARGE', 'NURSING_STAFF', 'OP_STAFF_NURSE'],
    NURSING_STAFF: ['NURSING_STAFF'],
    PHARMACY_STAFF: ['PHARMACY_STAFF'],
    LAB_STAFF: ['LAB_STAFF'],
    RADIOLOGY_STAFF: ['RADIOLOGY_STAFF'],
    GENERAL_STAFF: ['GENERAL_STAFF'],
    HOUSEKEEPING_STAFF: ['HOUSEKEEPING_STAFF'],
    HOUSEKEEPING_INCHARGE: ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'],
    RECEPTIONIST: ['RECEPTIONIST'],
    SECURITY: ['SECURITY'],
    MAINTENANCE: ['MAINTENANCE'],
    EMERGENCY_RESPONDER: ['EMERGENCY_RESPONDER']
  };

  return hierarchy[userRole] || [userRole];
}

// Calculate working hours
export function calculateWorkingHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) {
    return 0;
  }
  const diff = new Date(checkOut) - new Date(checkIn);
  return Math.max(0, diff / (1000 * 60 * 60)); // Hours
}

// Format date to DD-MM-YYYY
export function formatDateDDMMYYYY(date) {
  if (!date) {
    return null;
  }
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Format date time to DD-MM-YYYY HH:mm
export function formatDateTimeDDMMYYYY(date) {
  if (!date) {
    return null;
  }
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}
