// src/components/auth/ProtectedRoute.tsx
"use client";

import { StoredAdminUserSchema } from "@/lib/schemas";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

type Role =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "DOCTOR"
  | "NURSE"
  | "PHARMACIST"
  | "TECHNICIAN"
  | "RECEPTIONIST"
  | "PATIENT";

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: Role;
  requiredPermissions?: string[];
  /** Where to send the user if they're unauthorized */
  fallbackPath?: string;
}

export function ProtectedRoute({
  children,
  requiredRole,
  requiredPermissions = [],
  fallbackPath = "/dashboard",
}: ProtectedRouteProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState<Role | null>(null);
  const [userPerms, setUserPerms] = useState<string[]>([]);

  useEffect(() => {
    try {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("adminToken")
          : null;
      const userStr =
        typeof window !== "undefined"
          ? localStorage.getItem("adminUser")
          : null;

      if (!token) {
        setIsAuthenticated(false);
        setIsLoading(false);
        router.push("/login");
        return;
      }

      setIsAuthenticated(true);

      if (userStr) {
        try {
          const parsed: unknown = JSON.parse(userStr);
          const result = StoredAdminUserSchema.safeParse(parsed);
          if (result.success) {
            setUserRole(result.data.role as Role);
            setUserPerms(result.data.permissions);
          } else {
            // Clear corrupted data
            localStorage.removeItem("adminUser");
          }
        } catch {
          // don't crash on bad JSON in storage
          localStorage.removeItem("adminUser");
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-b-2 border-primary" />
          <p className="mt-4 text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Redirect handled above
    return null;
  }

  const isSuperAdmin = userRole === "SUPER_ADMIN";
  const roleAllowed =
    !requiredRole ||
    isSuperAdmin ||
    (userRole !== null && userRole === requiredRole);

  const permsAllowed =
    requiredPermissions.length === 0 ||
    isSuperAdmin ||
    requiredPermissions.every((p) => userPerms.includes(p));

  if (!roleAllowed || !permsAllowed) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-destructive">Access denied</h2>
          <p className="mt-2 text-muted-foreground">
            You don&apos;t have permission to access this page.
          </p>
          <button
            type="button"
            onClick={() => router.push(fallbackPath)}
            className="mt-4 rounded bg-primary px-4 py-2 text-white hover:bg-primary/90"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
