/**
 * Centralized role group helpers.
 * Use these instead of inline role arrays to keep role logic DRY.
 * When a new role is added, update the group here and it propagates everywhere.
 */

// Individual role constants (re-exported for convenience)
export const ROLES = {
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  NURSING_STAFF: 'NURSING_STAFF',
  PHARMACY_STAFF: 'PHARMACY_STAFF',
  LAB_STAFF: 'LAB_STAFF',
  HR_STAFF: 'HR_STAFF',
  GENERAL_STAFF: 'GENERAL_STAFF',
  DELIVERY_STAFF: 'DELIVERY_STAFF',
  ADMIN: 'ADMIN',
  RECEPTIONIST: 'RECEPTIONIST',
};

// Role groups
export const CLINICAL_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF];
export const ALL_STAFF_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF, ROLES.PHARMACY_STAFF, ROLES.LAB_STAFF, ROLES.HR_STAFF, ROLES.GENERAL_STAFF, ROLES.DELIVERY_STAFF, ROLES.RECEPTIONIST];
export const ADMIN_ROLES = [ROLES.ADMIN];
export const PATIENT_AND_CLINICAL = [ROLES.PATIENT, ...CLINICAL_ROLES];

// Role check helpers
export const isAdmin = (role) => role === ROLES.ADMIN;
export const isPatient = (role) => role === ROLES.PATIENT;
export const isDoctor = (role) => role === ROLES.DOCTOR;
export const isClinical = (role) => CLINICAL_ROLES.includes(role);
export const isStaff = (role) => ALL_STAFF_ROLES.includes(role) || isAdmin(role);
export const isStaffOrAdmin = (role) => isStaff(role);
export const canViewMedicalData = (role) => isClinical(role) || isAdmin(role);
