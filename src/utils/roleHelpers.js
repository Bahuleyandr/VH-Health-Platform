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
  // New roles
  SECURITY: 'SECURITY',
  EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER',
  RADIOLOGIST: 'RADIOLOGIST',
  ANESTHETIST: 'ANESTHETIST',
  DIETITIAN: 'DIETITIAN',
  PHYSIOTHERAPIST: 'PHYSIOTHERAPIST',
  SOCIAL_WORKER: 'SOCIAL_WORKER',
  BILLING_STAFF: 'BILLING_STAFF',
  INSURANCE_COORDINATOR: 'INSURANCE_COORDINATOR',
  QUALITY_OFFICER: 'QUALITY_OFFICER',
  INFECTION_CONTROL_OFFICER: 'INFECTION_CONTROL_OFFICER',
  OT_STAFF: 'OT_STAFF',
  BLOOD_BANK_TECHNICIAN: 'BLOOD_BANK_TECHNICIAN',
  DEPARTMENT_HEAD: 'DEPARTMENT_HEAD',
  CMO: 'CMO',
  CNO: 'CNO',
};

// Role groups
export const CLINICAL_ROLES = [ROLES.DOCTOR, ROLES.NURSING_STAFF, ROLES.RADIOLOGIST, ROLES.ANESTHETIST, ROLES.PHYSIOTHERAPIST, ROLES.DIETITIAN];
export const LEADERSHIP_ROLES = [ROLES.CMO, ROLES.CNO, ROLES.DEPARTMENT_HEAD];
export const SUPPORT_ROLES = [ROLES.SOCIAL_WORKER, ROLES.SECURITY, ROLES.BILLING_STAFF, ROLES.INSURANCE_COORDINATOR, ROLES.QUALITY_OFFICER, ROLES.INFECTION_CONTROL_OFFICER];
export const ALL_STAFF_ROLES = [...CLINICAL_ROLES, ROLES.PHARMACY_STAFF, ROLES.LAB_STAFF, ROLES.HR_STAFF, ROLES.GENERAL_STAFF, ROLES.DELIVERY_STAFF, ROLES.RECEPTIONIST, ROLES.MEDICAL_RECORDS, ROLES.OT_STAFF, ROLES.BLOOD_BANK_TECHNICIAN, ...SUPPORT_ROLES, ...LEADERSHIP_ROLES];
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
export const isLeadership = (role) => LEADERSHIP_ROLES.includes(role) || role === ROLES.ADMIN;
export const isSupportStaff = (role) => SUPPORT_ROLES.includes(role);
export const canViewMedicalData = (role) => isClinical(role) || isAdmin(role) || isMedicalRecords(role);
export const canViewDischargeSummary = (role) => DISCHARGE_SUMMARY_VIEW_ROLES.includes(role);
export const canEditDischargeSummary = (role) => DISCHARGE_SUMMARY_EDIT_ROLES.includes(role);
export const canSignDischargeSummary = (role) => DISCHARGE_SUMMARY_SIGN_ROLES.includes(role);
export const canAccessRadiology = (role) => [ROLES.DOCTOR, ROLES.RADIOLOGIST, ROLES.ADMIN, ROLES.CMO].includes(role);
export const canAccessOT = (role) => [ROLES.DOCTOR, ROLES.OT_STAFF, ROLES.ANESTHETIST, ROLES.ADMIN, ROLES.CMO].includes(role);
export const canAccessBloodBank = (role) => [ROLES.DOCTOR, ROLES.NURSING_STAFF, ROLES.BLOOD_BANK_TECHNICIAN, ROLES.ADMIN].includes(role);
