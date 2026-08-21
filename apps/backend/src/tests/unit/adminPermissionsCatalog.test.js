// src/tests/unit/adminPermissionsCatalog.test.js
//
// Fail-closed vocabulary allowlist for admins.permissions
// (authService.updateAdminPermissions validates through this catalog).
// Pinned invariants:
//   * only matrix keys + the '*' wildcard pass;
//   * the admin-portal proxy's platformSuperAdmin sentinel is rejected BY
//     NAME (its SUPER_ADMIN-only guarantee must be structural, not a UI
//     convention);
//   * unknown strings are rejected, so arbitrary flags can never be stored.

import {
  ADMIN_PERMISSION_WILDCARD,
  GRANTABLE_ADMIN_PERMISSIONS,
  PLATFORM_SUPER_ADMIN_SENTINEL,
  assertValidAdminPermissions,
} from '../../config/adminPermissionsCatalog.js';

describe('vocabulary', () => {
  it('matches the admin-portal grantable matrix exactly', () => {
    // Mirror of PERMISSION_CATEGORIES in
    // apps/admin/.../admin-management/components/permissionsConfig.ts.
    // `adminManagement` is deliberately absent (vestigial post-#883).
    expect([...GRANTABLE_ADMIN_PERMISSIONS].sort()).toEqual([
      'appointmentManagement',
      'departmentManagement',
      'doctorManagement',
      'notificationManagement',
      'pharmacyAdminRoutes',
      'userManagement',
      'viewAuditLogs',
    ]);
    expect(GRANTABLE_ADMIN_PERMISSIONS).not.toContain('adminManagement');
  });

  it('accepts every grantable key plus the wildcard, deduplicated', () => {
    const input = [
      ADMIN_PERMISSION_WILDCARD,
      ...GRANTABLE_ADMIN_PERMISSIONS,
      'userManagement', // duplicate
    ];
    expect(assertValidAdminPermissions(input)).toEqual([
      ADMIN_PERMISSION_WILDCARD,
      ...GRANTABLE_ADMIN_PERMISSIONS,
    ]);
  });

  it('treats null/undefined as an empty grant', () => {
    expect(assertValidAdminPermissions(null)).toEqual([]);
    expect(assertValidAdminPermissions(undefined)).toEqual([]);
  });
});

describe('fail-closed rejections', () => {
  it('rejects the platformSuperAdmin sentinel by name, any casing', () => {
    for (const spelling of [
      PLATFORM_SUPER_ADMIN_SENTINEL,
      'PLATFORMSUPERADMIN',
      ' platformSuperAdmin ',
    ]) {
      expect(() => assertValidAdminPermissions([spelling])).toThrow(
        expect.objectContaining({
          statusCode: 400,
          code: 'ADMIN_PERMISSIONS_SENTINEL_REJECTED',
        }),
      );
    }
  });

  it('rejects unknown permission strings (incl. the vestigial adminManagement)', () => {
    for (const bad of ['adminManagement', 'root', 'entitlements', '**']) {
      expect(() => assertValidAdminPermissions(['userManagement', bad])).toThrow(
        expect.objectContaining({
          statusCode: 400,
          code: 'ADMIN_PERMISSIONS_UNKNOWN_KEY',
        }),
      );
    }
  });

  it('rejects non-array and non-string entries', () => {
    expect(() => assertValidAdminPermissions('userManagement')).toThrow(
      expect.objectContaining({ code: 'ADMIN_PERMISSIONS_INVALID' }),
    );
    expect(() => assertValidAdminPermissions([{ permission: 'userManagement' }])).toThrow(
      expect.objectContaining({ code: 'ADMIN_PERMISSIONS_INVALID' }),
    );
    expect(() => assertValidAdminPermissions([42])).toThrow(
      expect.objectContaining({ code: 'ADMIN_PERMISSIONS_INVALID' }),
    );
  });
});
