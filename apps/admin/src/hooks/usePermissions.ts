// src/hooks/usePermissions.ts
'use client';

import { useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { AdminUser, AdminRole } from '@/lib/types';

// Role hierarchy (higher index = more privileged)
const ROLE_ORDER: AdminRole[] = ['STAFF', 'DOCTOR', 'HR', 'ADMIN', 'SUPER_ADMIN'];

const HR_DOMAIN_ROLES = new Set(['HR_STAFF']);
const DOCTOR_DOMAIN_ROLES = new Set([
  'DOCTOR',
  'ANAESTHETIST',
  'DUTY_DOCTOR',
  'MEDICAL_SUPERINTENDENT',
]);
const ADMIN_DOMAIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const IT_DOMAIN_ROLES = new Set(['IT', 'IT_ADMIN', 'IT_STAFF', 'SYSTEM_ADMIN']);

function normalizePortalRole(role: AdminRole | null): AdminRole | null {
  if (!role) return null;
  if (ADMIN_DOMAIN_ROLES.has(role) || IT_DOMAIN_ROLES.has(role)) return role;
  if (HR_DOMAIN_ROLES.has(role)) return 'HR';
  if (DOCTOR_DOMAIN_ROLES.has(role)) return 'DOCTOR';
  if (role === 'HR' || role === 'DOCTOR' || role === 'STAFF') return role;
  return 'STAFF';
}

function roleRank(role: AdminRole | null): number {
  if (!role) return -1;
  return ROLE_ORDER.indexOf(role);
}

export interface UsePermissionsOptions {
  requiredRole?: AdminRole;
  requiredPermissions?: string[];
}

export interface UsePermissionsResult {
  user: AdminUser | null;
  role: AdminRole | null;
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

  const rawRole = (user?.role as AdminRole | undefined) ?? null;
  const role = normalizePortalRole(rawRole);

  const permissions = useMemo<string[]>(
    () => user?.permissions ?? [],
    [user]
  );

  const isSuperAdmin = role === 'SUPER_ADMIN' || permissions.includes('*');
  const isAdmin      = isSuperAdmin || role === 'ADMIN';
  const isHR         = role === 'HR';
  const isDoctor     = role === 'DOCTOR';
  const isStaff      = role === 'STAFF';

  const isHROrAbove     = isSuperAdmin || role === 'ADMIN' || role === 'HR';
  const isStaffOrAbove  = roleRank(role) >= roleRank('STAFF');

  const hasPermission = useCallback(
    (perm: string) => isSuperAdmin || permissions.includes(perm),
    [isSuperAdmin, permissions]
  );

  const hasAnyPermission = useCallback(
    (perms: string[]) => isSuperAdmin || perms.some((p) => permissions.includes(p)),
    [isSuperAdmin, permissions]
  );

  const hasAllPermissions = useCallback(
    (perms: string[]) => isSuperAdmin || perms.every((p) => permissions.includes(p)),
    [isSuperAdmin, permissions]
  );

  const { roleAllowed, permsAllowed, allowed } = useMemo(() => {
    const requiredRole = options?.requiredRole;
    const requiredPermissions = options?.requiredPermissions ?? [];

    const roleAllowed =
      !requiredRole ||
      isSuperAdmin ||
      role === requiredRole ||
      // If required role is in hierarchy, allow anything above it
      roleRank(role) >= roleRank(requiredRole);

    const permsAllowed =
      requiredPermissions.length === 0 || hasAllPermissions(requiredPermissions);

    const allowed = !!user && !loading && roleAllowed && permsAllowed;

    return { roleAllowed, permsAllowed, allowed };
  }, [
    options?.requiredRole,
    options?.requiredPermissions,
    isSuperAdmin,
    role,
    user,
    loading,
    hasAllPermissions,
  ]);

  return {
    user: user ?? null,
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
