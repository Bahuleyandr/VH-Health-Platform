// src/config/adminPermissionsCatalog.js
//
// Canonical vocabulary for per-admin permission flags (admins.permissions).
//
// Before this catalog existed, updateAdminPermissions stored arbitrary
// strings. Combined with the admin-portal proxy's sentinel design (the
// `platformSuperAdmin` gate in apps/admin/src/lib/proxyPermissions.ts is
// "ungrantable" only by UI convention), a SUPER_ADMIN could grant an ADMIN
// the literal sentinel string and open the proxy's entitlements prefix for
// that ADMIN. This allowlist makes the sentinel guarantee structural:
// unknown keys are rejected fail-closed, and the proxy sentinel is rejected
// by name with its own error code.
//
// Keep in sync with the grantable matrix in
// apps/admin/src/app/(with-auth)/dashboard/admin-management/components/permissionsConfig.ts
// (PERMISSION_CATEGORIES) and the proxy gate map in
// apps/admin/src/lib/proxyPermissions.ts. `adminManagement` is deliberately
// absent: post-#883 every endpoint it gated is backend SUPER_ADMIN-only, so
// the flag grants nothing and is no longer written.

import { AppError } from '../utils/AppError.js';

/** Full-access wildcard most ADMIN accounts carry. */
export const ADMIN_PERMISSION_WILDCARD = '*';

/**
 * The admin-portal proxy's SUPER_ADMIN-only sentinel. Never grantable — the
 * proxy treats gates requiring it as "no per-admin flag can satisfy this".
 */
export const PLATFORM_SUPER_ADMIN_SENTINEL = 'platformSuperAdmin';

/** Grantable per-admin permission flags (matrix vocabulary). */
export const GRANTABLE_ADMIN_PERMISSIONS = Object.freeze([
  'userManagement',
  'doctorManagement',
  'departmentManagement',
  'appointmentManagement',
  'pharmacyAdminRoutes',
  'notificationManagement',
  'viewAuditLogs',
]);

const KNOWN_ADMIN_PERMISSIONS = new Set([
  ADMIN_PERMISSION_WILDCARD,
  ...GRANTABLE_ADMIN_PERMISSIONS,
]);

/**
 * Validate a permissions array against the catalog, fail-closed.
 *
 * @param {unknown} permissions
 * @returns {string[]} the validated array (deduplicated, original order)
 * @throws {AppError} 400 on a non-array / non-string entry / unknown key;
 *   the proxy sentinel is rejected explicitly with its own code.
 */
export function assertValidAdminPermissions(permissions) {
  if (permissions === null || permissions === undefined) return [];
  if (!Array.isArray(permissions)) {
    throw AppError.badRequest('Permissions must be an array', 'ADMIN_PERMISSIONS_INVALID');
  }
  const seen = new Set();
  const validated = [];
  for (const entry of permissions) {
    if (typeof entry !== 'string') {
      throw AppError.badRequest(
        'Permissions must be strings',
        'ADMIN_PERMISSIONS_INVALID',
      );
    }
    const value = entry.trim();
    // Reject the proxy sentinel by name (case-insensitive) so the
    // "SUPER_ADMIN-only" guarantee cannot be granted onto an ADMIN account.
    if (value.toLowerCase() === PLATFORM_SUPER_ADMIN_SENTINEL.toLowerCase()) {
      throw AppError.badRequest(
        'The platform super-admin sentinel is not a grantable permission',
        'ADMIN_PERMISSIONS_SENTINEL_REJECTED',
      );
    }
    if (!KNOWN_ADMIN_PERMISSIONS.has(value)) {
      throw AppError.badRequest(
        `Unknown permission key: ${value}`,
        'ADMIN_PERMISSIONS_UNKNOWN_KEY',
      );
    }
    if (!seen.has(value)) {
      seen.add(value);
      validated.push(value);
    }
  }
  return validated;
}

export default {
  ADMIN_PERMISSION_WILDCARD,
  PLATFORM_SUPER_ADMIN_SENTINEL,
  GRANTABLE_ADMIN_PERMISSIONS,
  assertValidAdminPermissions,
};
