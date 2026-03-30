// src/utils/roles.js

// ✅ Centralized Role Definitions
export const SUPER_ADMIN   = 'SUPER_ADMIN';
export const ADMIN         = 'ADMIN';
export const PATIENT       = 'PATIENT';
export const NURSING_STAFF = 'NURSING_STAFF';
export const PHARMACY_STAFF= 'PHARMACY_STAFF';
export const LAB_STAFF     = 'LAB_STAFF';
export const DOCTOR        = 'DOCTOR';
export const GENERAL_STAFF = 'GENERAL_STAFF';
export const HR_STAFF      = 'HR_STAFF';
export const MEDICAL_RECORDS = 'MEDICAL_RECORDS';
export const RECEPTIONIST    = 'RECEPTIONIST';
export const DELIVERY_STAFF  = 'DELIVERY_STAFF';

// Clinical specialty
export const RADIOLOGIST     = 'RADIOLOGIST';
export const ANESTHETIST     = 'ANESTHETIST';

// Allied health
export const DIETITIAN       = 'DIETITIAN';
export const PHYSIOTHERAPIST = 'PHYSIOTHERAPIST';
export const SOCIAL_WORKER   = 'SOCIAL_WORKER';

// Security & emergency
export const SECURITY            = 'SECURITY';
export const EMERGENCY_RESPONDER = 'EMERGENCY_RESPONDER';

// Finance
export const BILLING_STAFF        = 'BILLING_STAFF';
export const INSURANCE_COORDINATOR = 'INSURANCE_COORDINATOR';

// Quality & safety
export const QUALITY_OFFICER          = 'QUALITY_OFFICER';
export const INFECTION_CONTROL_OFFICER = 'INFECTION_CONTROL_OFFICER';

// Specialized services
export const OT_STAFF              = 'OT_STAFF';
export const BLOOD_BANK_TECHNICIAN = 'BLOOD_BANK_TECHNICIAN';

// Leadership
export const DEPARTMENT_HEAD = 'DEPARTMENT_HEAD';
export const CMO             = 'CMO';
export const CNO             = 'CNO';

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
  RECEPTIONIST,
  DELIVERY_STAFF,
  DIETITIAN,
  PHYSIOTHERAPIST,
  SOCIAL_WORKER,
  SECURITY,
  EMERGENCY_RESPONDER,
  BILLING_STAFF,
  INSURANCE_COORDINATOR,
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
    typeof userOrRole === 'string'
      ? normalizeRole(userOrRole)
      : normalizeRole(userOrRole?.role);

  if (!role) return false;

  // SUPER_ADMIN bypass
  if (role === SUPER_ADMIN) return true;

  const allowed = allowedRoles.map(normalizeRole).filter(Boolean);
  return allowed.includes(role);
}
