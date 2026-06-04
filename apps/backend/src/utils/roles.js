// src/utils/roles.js

// ✅ Centralized Role Definitions
export const SUPER_ADMIN = 'SUPER_ADMIN';
export const ADMIN = 'ADMIN';
export const PATIENT = 'PATIENT';
export const NURSING_STAFF = 'NURSING_STAFF';
export const NURSING_INCHARGE = 'NURSING_INCHARGE';
export const OP_STAFF_NURSE = 'OP_STAFF_NURSE';
export const OP_INCHARGE = 'OP_INCHARGE';
export const IP_STAFF_NURSE = 'IP_STAFF_NURSE';
export const IP_INCHARGE = 'IP_INCHARGE';
export const OT_NURSE = 'OT_NURSE';
export const OT_INCHARGE = 'OT_INCHARGE';
export const CATH_LAB_STAFF = 'CATH_LAB_STAFF';
export const CATH_LAB_INCHARGE = 'CATH_LAB_INCHARGE';
export const PHARMACY_STAFF = 'PHARMACY_STAFF';
export const LAB_STAFF = 'LAB_STAFF';
export const DOCTOR = 'DOCTOR';
export const DUTY_DOCTOR = 'DUTY_DOCTOR';
export const MEDICAL_SUPERINTENDENT = 'MEDICAL_SUPERINTENDENT';
export const GENERAL_STAFF = 'GENERAL_STAFF';
export const HOUSEKEEPING_STAFF = 'HOUSEKEEPING_STAFF';
export const HOUSEKEEPING_INCHARGE = 'HOUSEKEEPING_INCHARGE';
export const MAINTENANCE = 'MAINTENANCE';
export const HR_STAFF = 'HR_STAFF';
export const MEDICAL_RECORDS = 'MEDICAL_RECORDS';
export const RECEPTIONIST = 'RECEPTIONIST';
export const RECEPTION_INCHARGE = 'RECEPTION_INCHARGE';
export const DELIVERY_STAFF = 'DELIVERY_STAFF';
export const DRIVER = 'DRIVER';
export const IT = 'IT';
export const IT_STAFF = 'IT_STAFF';
export const IT_ADMIN = 'IT_ADMIN';
export const SYSTEM_ADMIN = 'SYSTEM_ADMIN';

// Clinical specialty
export const RADIOLOGIST = 'RADIOLOGIST';
export const RADIOLOGY_STAFF = 'RADIOLOGY_STAFF';
export const ANAESTHETIST = 'ANAESTHETIST';
export const ANESTHETIST = 'ANESTHETIST';

// Allied health
export const DIETITIAN = 'DIETITIAN';
export const PHYSIOTHERAPIST = 'PHYSIOTHERAPIST';
export const SOCIAL_WORKER = 'SOCIAL_WORKER';

// Security & emergency
export const SECURITY = 'SECURITY';
export const EMERGENCY_RESPONDER = 'EMERGENCY_RESPONDER';

// Finance
export const BILLING_STAFF = 'BILLING_STAFF';
export const BILLING_INCHARGE = 'BILLING_INCHARGE';
export const FINANCE_INCHARGE = 'FINANCE_INCHARGE';
export const INSURANCE_COORDINATOR = 'INSURANCE_COORDINATOR';

// Admissions desk (Stage-5 — seeded by seed-test-staff-accounts.mjs;
// already referenced by app.js CLINICAL_STAFF_ROLES + /ipd + /bed-inspections
// route gates, but were missing from this constants file).
export const ADMISSION_OFFICER = 'ADMISSION_OFFICER';
export const IPD_COUNSELLOR = 'IPD_COUNSELLOR';
export const AMBULANCE_COORDINATOR = 'AMBULANCE_COORDINATOR';

// Quality & safety
export const QUALITY_OFFICER = 'QUALITY_OFFICER';
export const INFECTION_CONTROL_OFFICER = 'INFECTION_CONTROL_OFFICER';

// Specialized services
export const OT_STAFF = 'OT_STAFF';
export const BLOOD_BANK_TECHNICIAN = 'BLOOD_BANK_TECHNICIAN';

// Leadership
export const DEPARTMENT_HEAD = 'DEPARTMENT_HEAD';
export const CMO = 'CMO';
export const CNO = 'CNO';

// Useful aggregate (keep in a predictable order for UIs)
export const ALL_ROLES = [
  SUPER_ADMIN,
  ADMIN,
  CMO,
  CNO,
  DEPARTMENT_HEAD,
  MEDICAL_SUPERINTENDENT,
  DOCTOR,
  DUTY_DOCTOR,
  NURSING_STAFF,
  NURSING_INCHARGE,
  OP_STAFF_NURSE,
  OP_INCHARGE,
  IP_STAFF_NURSE,
  IP_INCHARGE,
  OT_NURSE,
  OT_INCHARGE,
  CATH_LAB_STAFF,
  CATH_LAB_INCHARGE,
  RADIOLOGIST,
  RADIOLOGY_STAFF,
  ANAESTHETIST,
  ANESTHETIST,
  PHARMACY_STAFF,
  LAB_STAFF,
  HR_STAFF,
  MEDICAL_RECORDS,
  GENERAL_STAFF,
  HOUSEKEEPING_STAFF,
  HOUSEKEEPING_INCHARGE,
  MAINTENANCE,
  RECEPTIONIST,
  RECEPTION_INCHARGE,
  DELIVERY_STAFF,
  DRIVER,
  IT,
  IT_STAFF,
  IT_ADMIN,
  SYSTEM_ADMIN,
  DIETITIAN,
  PHYSIOTHERAPIST,
  SOCIAL_WORKER,
  SECURITY,
  EMERGENCY_RESPONDER,
  BILLING_STAFF,
  BILLING_INCHARGE,
  FINANCE_INCHARGE,
  INSURANCE_COORDINATOR,
  ADMISSION_OFFICER,
  IPD_COUNSELLOR,
  AMBULANCE_COORDINATOR,
  QUALITY_OFFICER,
  INFECTION_CONTROL_OFFICER,
  OT_STAFF,
  BLOOD_BANK_TECHNICIAN,
  PATIENT
];

const ROLE_ALIASES = new Map([
  ['CHIEF_MEDICAL_OFFICER', CMO],
  ['CHIEF_NURSING_OFFICER', CNO],
  ['CONSULTANT_PHYSICIAN', 'CONSULTANT'],
  ['DMO', DUTY_DOCTOR],
  ['DUTY_MEDICAL_OFFICER', DUTY_DOCTOR],
  ['FLOOR_DOCTOR', DUTY_DOCTOR],
  ['HOUSEKEEPING', HOUSEKEEPING_STAFF],
  ['HOUSEKEEPING_ATTENDANT', HOUSEKEEPING_STAFF],
  ['MEDICAL_SUPERINTENDANT', MEDICAL_SUPERINTENDENT],
  ['MEDICAL_SUPERINTENDENT_ROLE', MEDICAL_SUPERINTENDENT],
  ['NURSE', NURSING_STAFF],
  ['CATHLAB_NURSE', CATH_LAB_STAFF],
  ['CATHLAB_STAFF', CATH_LAB_STAFF],
  ['CATH_LAB_NURSE', CATH_LAB_STAFF],
  ['CATH_LAB_TECH', CATH_LAB_STAFF],
  ['CATH_LAB_TECHNICIAN', CATH_LAB_STAFF],
  ['CATHLAB_INCHARGE', CATH_LAB_INCHARGE],
  ['CATH_LAB_IN_CHARGE', CATH_LAB_INCHARGE],
  ['IP_NURSE', IP_STAFF_NURSE],
  ['IP_STAFF', IP_STAFF_NURSE],
  ['IPD_NURSE', IP_STAFF_NURSE],
  ['IPD_STAFF_NURSE', IP_STAFF_NURSE],
  ['IPD_INCHARGE', IP_INCHARGE],
  ['IP_NURSING_INCHARGE', IP_INCHARGE],
  ['NURSING_IN_CHARGE', NURSING_INCHARGE],
  ['NURSING_INCHARGE_ROLE', NURSING_INCHARGE],
  ['NURSING_SUPERVISOR', NURSING_INCHARGE],
  ['NURSING_SUPERINTENDENT', CNO],
  ['OT_IN_CHARGE', OT_INCHARGE],
  ['OT_NURSING_INCHARGE', OT_INCHARGE],
  ['OT_STAFF', OT_NURSE],
  ['THEATRE_INCHARGE', OT_INCHARGE],
  ['THEATRE_NURSING_INCHARGE', OT_INCHARGE],
  ['REGISTERED_NURSE', NURSING_STAFF],
  ['STAFF_NURSE', NURSING_STAFF],
  ['WARD_NURSE', IP_STAFF_NURSE],
  ['WARD_NURSING_INCHARGE', NURSING_INCHARGE],
]);

/**
 * Normalize a role string safely.
 * @param {string} role
 * @returns {string|null}
 */
export function normalizeRole(role) {
  if (!role || typeof role !== 'string') return null;
  const normalized = role.trim().toUpperCase();
  return ROLE_ALIASES.get(normalized) || normalized;
}

/**
 * Quick check for admin-tier roles.
 * SUPER_ADMIN is always considered admin-tier.
 * @param {string} role
 * @returns {boolean}
 */
export function isAdminish(role) {
  const r = normalizeRole(role);
  return r === SUPER_ADMIN || r === ADMIN;
}

/**
 * Case-insensitive RBAC role check.
 * - Accepts either a user object with `role`, or a raw role string.
 * - SUPER_ADMIN always passes (global bypass).
 * - Empty `allowedRoles` means "public" (allow).
 *
 * @param {Object|string} userOrRole - user object with `role`, or a raw role string
 * @param {string[]} allowedRoles - list of allowed roles (constants recommended)
 * @returns {boolean}
 */
export function hasRole(userOrRole, allowedRoles = []) {
  // Public routes (no restriction)
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return true;

  const role =
    typeof userOrRole === 'string' ? normalizeRole(userOrRole) : normalizeRole(userOrRole?.role);

  if (!role) return false;

  // SUPER_ADMIN bypass
  if (role === SUPER_ADMIN) return true;

  const allowed = allowedRoles.map(normalizeRole).filter(Boolean);
  return allowed.includes(role);
}
