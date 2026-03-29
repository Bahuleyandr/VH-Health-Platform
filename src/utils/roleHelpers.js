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
  MEDICAL_RECORDS: 'MEDICAL_RECORDS',
  ADMIN: 'ADMIN',
  RECEPTIONIST: 'RECEPTIONIST',
};

// Role groups
export const CLINICAL_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF];
export const ALL_STAFF_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF, ROLES.PHARMACY_STAFF, ROLES.LAB_STAFF, ROLES.HR_STAFF, ROLES.GENERAL_STAFF, ROLES.DELIVERY_STAFF, ROLES.RECEPTIONIST, ROLES.MEDICAL_RECORDS];
export const ADMIN_ROLES = [ROLES.ADMIN];
export const PATIENT_AND_CLINICAL = [ROLES.PATIENT, ...CLINICAL_ROLES];

// Roles that can view/edit/generate discharge summaries
export const DISCHARGE_SUMMARY_VIEW_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF, ROLES.MEDICAL_RECORDS, ROLES.ADMIN];
export const DISCHARGE_SUMMARY_EDIT_ROLES = [ROLES.DOCTOR, ROLES.MEDICAL_RECORDS, ROLES.ADMIN];
export const DISCHARGE_SUMMARY_SIGN_ROLES = [ROLES.DOCTOR]; // Only doctors sign — ADMIN can override via SUPER_ADMIN

// Role check helpers
export const isAdmin = (role) => role === ROLES.ADMIN;
export const isPatient = (role) => role === ROLES.PATIENT;
export const isDoctor = (role) => role === ROLES.DOCTOR;
export const isClinical = (role) => CLINICAL_ROLES.includes(role);
export const isMedicalRecords = (role) => role === ROLES.MEDICAL_RECORDS;
export const isStaff = (role) => ALL_STAFF_ROLES.includes(role) || isAdmin(role);
export const isStaffOrAdmin = (role) => isStaff(role);
export const canViewMedicalData = (role) => isClinical(role) || isAdmin(role) || isMedicalRecords(role);
export const canViewDischargeSummary = (role) => DISCHARGE_SUMMARY_VIEW_ROLES.includes(role);
export const canEditDischargeSummary = (role) => DISCHARGE_SUMMARY_EDIT_ROLES.includes(role);
export const canSignDischargeSummary = (role) => DISCHARGE_SUMMARY_SIGN_ROLES.includes(role);
