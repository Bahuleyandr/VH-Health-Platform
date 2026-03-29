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

// Useful aggregate (keep in a predictable order for UIs)
export const ALL_ROLES = [
  SUPER_ADMIN,
  ADMIN,
  DOCTOR,
  NURSING_STAFF,
  PHARMACY_STAFF,
  LAB_STAFF,
  HR_STAFF,
  MEDICAL_RECORDS,
  GENERAL_STAFF,
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
