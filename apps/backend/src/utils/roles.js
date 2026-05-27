// src/utils/roles.js

// ✅ Centralized Role Definitions
export const SUPER_ADMIN = 'SUPER_ADMIN';
export const ADMIN = 'ADMIN';
export const PATIENT = 'PATIENT';
export const NURSING_STAFF = 'NURSING_STAFF';
export const PHARMACY_STAFF = 'PHARMACY_STAFF';
export const LAB_STAFF = 'LAB_STAFF';
export const DOCTOR = 'DOCTOR';
export const GENERAL_STAFF = 'GENERAL_STAFF';
export const HOUSEKEEPING_STAFF = 'HOUSEKEEPING_STAFF';
export const HOUSEKEEPING_INCHARGE = 'HOUSEKEEPING_INCHARGE';
export const MAINTENANCE = 'MAINTENANCE';
export const HR_STAFF = 'HR_STAFF';
export const MEDICAL_RECORDS = 'MEDICAL_RECORDS';
export const RECEPTIONIST = 'RECEPTIONIST';
export const DELIVERY_STAFF = 'DELIVERY_STAFF';
export const IT = 'IT';
export const IT_STAFF = 'IT_STAFF';
export const IT_ADMIN = 'IT_ADMIN';
export const SYSTEM_ADMIN = 'SYSTEM_ADMIN';

// Clinical specialty
export const RADIOLOGIST = 'RADIOLOGIST';
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
export const INSURANCE_COORDINATOR = 'INSURANCE_COORDINATOR';

// Admissions desk (Stage-5 — seeded by seed-test-staff-accounts.mjs;
// already referenced by app.js CLINICAL_STAFF_ROLES + /ipd + /bed-inspections
// route gates, but were missing from this constants file).
export const ADMISSION_OFFICER = 'ADMISSION_OFFICER';
export const IPD_COUNSELLOR = 'IPD_COUNSELLOR';

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
  DOCTOR,
  NURSING_STAFF,
  RADIOLOGIST,
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
  DELIVERY_STAFF,
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
  INSURANCE_COORDINATOR,
  ADMISSION_OFFICER,
  IPD_COUNSELLOR,
  QUALITY_OFFICER,
  INFECTION_CONTROL_OFFICER,
  OT_STAFF,
  BLOOD_BANK_TECHNICIAN,
  PATIENT
];

/**
 * Normalize a role string safely.
 * @param {string} role
 * @returns {string|null}
 */
export function normalizeRole(role) {
  if (!role || typeof role !== 'string') return null;
  return role.trim().toUpperCase();
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
