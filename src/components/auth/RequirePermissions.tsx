// src/components/auth/RequirePermissions.tsx
"use client";

import type { ReactNode } from "react";
import { usePermissions } from "@/hooks/usePermissions";

interface RequirePermissionsProps {
  requiredRole?: "ADMIN" | "SUPER_ADMIN";
  requiredPermissions?: string[];
  children: ReactNode;
  /** Optional fallback if not allowed (otherwise renders null) */
  fallback?: ReactNode;
}

export function RequirePermissions({
  requiredRole,
  requiredPermissions,
  children,
  fallback = null,
}: RequirePermissionsProps) {
  const { allowed } = usePermissions({ requiredRole, requiredPermissions });
  return allowed ? <>{children}</> : <>{fallback}</>;
}
