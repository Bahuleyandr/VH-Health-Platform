// src/utils/roles.js

// ✅ Centralized Role Definitions
export const ADMIN = 'ADMIN';
export const PATIENT = 'PATIENT';
export const NURSING_STAFF = 'NURSING_STAFF';
export const PHARMACY_STAFF = 'PHARMACY_STAFF';
export const LAB_STAFF = 'LAB_STAFF';
export const DOCTOR = 'DOCTOR';
export const GENERAL_STAFF = 'GENERAL_STAFF';
export const HR_STAFF = 'HR_STAFF';

/**
 * Case-insensitive RBAC role check
 * @param {Object} user - The user object with a `role` property
 * @param {string[]} allowedRoles - List of allowed roles
 * @returns {boolean} - True if user role matches any allowed role
 */
export function hasRole(user, allowedRoles) {
  if (!user || !user.role) {return false;}

  const userRole = user.role.trim().toUpperCase();
  const allowedRolesUpper = allowedRoles.map(role => role.trim().toUpperCase());

  return allowedRolesUpper.includes(userRole);
}
