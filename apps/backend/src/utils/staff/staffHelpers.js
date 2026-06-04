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
  const onboardableStaffRoles = allStaffRoles.filter(
    (role) => !['SUPER_ADMIN', 'ADMIN'].includes(role),
  );
  const anaesthesiaRoles = ['ANAESTHETIST', 'ANESTHETIST'];
  const ipNursingRoles = ['NURSING_STAFF', 'IP_STAFF_NURSE'];
  const opNursingRoles = ['OP_STAFF_NURSE'];
  const otNursingRoles = ['OT_NURSE', 'OT_STAFF'];
  const cathLabRoles = ['CATH_LAB_STAFF', 'CATH_LAB_INCHARGE'];
  // Anaesthetists are clinical-doctor tier (same level as DOCTOR for the
  // theatre/ICU/PACU surfaces); RADIOLOGY_STAFF mirrors LAB_STAFF as a
  // self-contained role bucket. HR_STAFF now lists every modality role
  // so HR can see/manage the full clinical roster, not just the
  // legacy DOCTOR / NURSING_STAFF / PHARMACY_STAFF / LAB_STAFF subset.
  // Finding H' D30.
  const hierarchy = {
    SUPER_ADMIN: [...allStaffRoles, 'SUPER_ADMIN'],
    ADMIN: allStaffRoles,
    HR_STAFF: onboardableStaffRoles,
    DOCTOR: ['DOCTOR', ...anaesthesiaRoles, ...ipNursingRoles, ...otNursingRoles],
    ANAESTHETIST: ['ANAESTHETIST', 'ANESTHETIST', ...ipNursingRoles, ...otNursingRoles],
    ANESTHETIST: ['ANESTHETIST', 'ANAESTHETIST', ...ipNursingRoles, ...otNursingRoles],
    MEDICAL_SUPERINTENDENT: [
      'MEDICAL_SUPERINTENDENT',
      'DOCTOR',
      'DUTY_DOCTOR',
      ...anaesthesiaRoles,
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      ...ipNursingRoles,
      'OP_INCHARGE',
      ...opNursingRoles,
      ...otNursingRoles,
      ...cathLabRoles
    ],
    CNO: [
      'CNO',
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      ...ipNursingRoles,
      'OP_INCHARGE',
      ...opNursingRoles,
      ...otNursingRoles,
      ...cathLabRoles,
    ],
    NURSING_INCHARGE: ['NURSING_INCHARGE', 'IP_INCHARGE', ...ipNursingRoles, ...opNursingRoles],
    NURSING_STAFF: ['NURSING_STAFF'],
    IP_INCHARGE: ['IP_INCHARGE', ...ipNursingRoles],
    IP_STAFF_NURSE: ['IP_STAFF_NURSE'],
    OP_INCHARGE: ['OP_INCHARGE', ...opNursingRoles],
    OP_STAFF_NURSE: ['OP_STAFF_NURSE'],
    OT_NURSE: ['OT_NURSE', 'OT_STAFF'],
    OT_STAFF: ['OT_STAFF', 'OT_NURSE'],
    CATH_LAB_INCHARGE: cathLabRoles,
    CATH_LAB_STAFF: ['CATH_LAB_STAFF'],
    PHARMACY_STAFF: ['PHARMACY_STAFF'],
    LAB_STAFF: ['LAB_STAFF'],
    RADIOLOGY_STAFF: ['RADIOLOGY_STAFF'],
    GENERAL_STAFF: ['GENERAL_STAFF'],
    HOUSEKEEPING_STAFF: ['HOUSEKEEPING_STAFF'],
    HOUSEKEEPING_INCHARGE: ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'],
    RECEPTIONIST: ['RECEPTIONIST'],
    RECEPTION_INCHARGE: ['RECEPTIONIST', 'RECEPTION_INCHARGE'],
    BILLING_STAFF: ['BILLING_STAFF'],
    BILLING_INCHARGE: ['BILLING_STAFF', 'BILLING_INCHARGE'],
    FINANCE_INCHARGE: ['BILLING_STAFF', 'BILLING_INCHARGE', 'FINANCE_INCHARGE'],
    ADMISSION_OFFICER: ['ADMISSION_OFFICER'],
    INSURANCE_COORDINATOR: ['INSURANCE_COORDINATOR'],
    IPD_COUNSELLOR: ['IPD_COUNSELLOR'],
    DRIVER: ['DRIVER'],
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
