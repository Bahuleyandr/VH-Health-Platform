// src/hooks/usePermissions.ts
"use client";

import { useMemo, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import type { AdminUser } from "@/lib/types";

type AdminRole = "ADMIN" | "SUPER_ADMIN";

export interface UsePermissionsOptions {
  requiredRole?: AdminRole;
  requiredPermissions?: string[];
}

export interface UsePermissionsResult {
  user: AdminUser | null;
  role: AdminRole | null;
  permissions: string[];
  isSuperAdmin: boolean;
  loading: boolean;

  hasPermission: (perm: string) => boolean;
  hasAnyPermission: (perms: string[]) => boolean;
  hasAllPermissions: (perms: string[]) => boolean;

  allowed: boolean;
  roleAllowed: boolean;
  permsAllowed: boolean;
}

export function usePermissions(
  options?: UsePermissionsOptions,
): UsePermissionsResult {
  const { user, loading } = useAuth();

  const role = (user?.role as AdminRole | undefined) ?? null;
  const permissions = useMemo(
    () =>
      Array.isArray(user?.permissions) ? (user.permissions as string[]) : [],
    [user], // ✅ include user, resolves warning
  );
  const isSuperAdmin = role === "SUPER_ADMIN";

  const hasPermission = useCallback(
    (perm: string) => isSuperAdmin || permissions.includes(perm),
    [isSuperAdmin, permissions],
  );

  const hasAnyPermission = useCallback(
    (perms: string[]) =>
      isSuperAdmin || perms.some((p) => permissions.includes(p)),
    [isSuperAdmin, permissions],
  );

  const hasAllPermissions = useCallback(
    (perms: string[]) =>
      isSuperAdmin || perms.every((p) => permissions.includes(p)),
    [isSuperAdmin, permissions],
  );

  const { roleAllowed, permsAllowed, allowed } = useMemo(() => {
    const roleAllowed =
      !options?.requiredRole || isSuperAdmin || role === options.requiredRole;

    const permsNeeded = options?.requiredPermissions ?? [];
    const permsAllowed =
      permsNeeded.length === 0 || hasAllPermissions(permsNeeded);

    const allowed = !!user && roleAllowed && permsAllowed;

    return { roleAllowed, permsAllowed, allowed };
  }, [
    options?.requiredRole,
    options?.requiredPermissions,
    isSuperAdmin,
    role,
    user,
    hasAllPermissions,
  ]);

  return {
    user: user ?? null,
    role,
    permissions,
    isSuperAdmin,
    loading,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    allowed,
    roleAllowed,
    permsAllowed,
  };
}
