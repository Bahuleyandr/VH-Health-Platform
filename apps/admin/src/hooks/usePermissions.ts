// src/hooks/usePermissions.ts
'use client';

import { useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { AdminUser } from '@/lib/types';
import {
  normalizePortalRole,
  portalAccessLevel,
  portalRoleRank,
  type PortalAccessLevel,
} from '@/lib/roles';

export interface UsePermissionsOptions {
  requiredRole?: PortalAccessLevel;
  requiredPermissions?: string[];
}

export interface UsePermissionsResult {
  user: AdminUser | null;
  rawRole: string | null;
  role: PortalAccessLevel | null;
  permissions: string[];

  // Granular role checks
  isSuperAdmin: boolean;
  isAdmin: boolean;       // ADMIN | SUPER_ADMIN
  isHR: boolean;
  isDoctor: boolean;
  isStaff: boolean;

  // Tiered checks (role OR above)
  isHROrAbove: boolean;         // HR | ADMIN | SUPER_ADMIN
  isStaffOrAbove: boolean;      // STAFF | HR | DOCTOR | ADMIN | SUPER_ADMIN

  loading: boolean;

  hasPermission: (perm: string) => boolean;
  hasAnyPermission: (perms: string[]) => boolean;
  hasAllPermissions: (perms: string[]) => boolean;

  allowed: boolean;
  roleAllowed: boolean;
  permsAllowed: boolean;
}

export function usePermissions(options?: UsePermissionsOptions): UsePermissionsResult {
  const { user, loading } = useAuth();

  const rawRole = normalizePortalRole(user?.role);
  const role = portalAccessLevel(rawRole);
  const isRecognizedRole = rawRole !== null;

  const permissions = useMemo<string[]>(
    () => user?.permissions ?? [],
    [user]
  );

  const isSuperAdmin = rawRole === 'SUPER_ADMIN';
  const isAdmin      = isSuperAdmin || role === 'ADMIN';
  const isHR         = role === 'HR';
  const isDoctor     = role === 'DOCTOR';
  const isStaff      = role === 'STAFF';

  const isHROrAbove     = isSuperAdmin || role === 'ADMIN' || role === 'HR';
  const isStaffOrAbove  = portalRoleRank(rawRole) >= portalRoleRank('STAFF');

  const hasPermission = useCallback(
    (perm: string) => isRecognizedRole && (isSuperAdmin || permissions.includes('*') || permissions.includes(perm)),
    [isRecognizedRole, isSuperAdmin, permissions]
  );

  const hasAnyPermission = useCallback(
    (perms: string[]) => isRecognizedRole && (isSuperAdmin || permissions.includes('*') || perms.some((p) => permissions.includes(p))),
    [isRecognizedRole, isSuperAdmin, permissions]
  );

  const hasAllPermissions = useCallback(
    (perms: string[]) => isRecognizedRole && (isSuperAdmin || permissions.includes('*') || perms.every((p) => permissions.includes(p))),
    [isRecognizedRole, isSuperAdmin, permissions]
  );

  const { roleAllowed, permsAllowed, allowed } = useMemo(() => {
    const requiredRole = options?.requiredRole;
    const requiredPermissions = options?.requiredPermissions ?? [];

    const roleAllowed =
      isRecognizedRole &&
      (!requiredRole ||
        isSuperAdmin ||
        role === requiredRole ||
        // If required role is in hierarchy, allow anything above it
        portalRoleRank(rawRole) >= portalRoleRank(requiredRole));

    const permsAllowed =
      requiredPermissions.length === 0 || hasAllPermissions(requiredPermissions);

    const allowed = !!user && !loading && isRecognizedRole && roleAllowed && permsAllowed;

    return { roleAllowed, permsAllowed, allowed };
  }, [
    options?.requiredRole,
    options?.requiredPermissions,
    isSuperAdmin,
    role,
    rawRole,
    isRecognizedRole,
    user,
    loading,
    hasAllPermissions,
  ]);

  return {
    user: user ?? null,
    rawRole,
    role,
    permissions,
    isSuperAdmin,
    isAdmin,
    isHR,
    isDoctor,
    isStaff,
    isHROrAbove,
    isStaffOrAbove,
    loading,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    allowed,
    roleAllowed,
    permsAllowed,
  };
}
