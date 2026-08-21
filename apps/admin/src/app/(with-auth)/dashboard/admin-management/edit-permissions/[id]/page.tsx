// src/app/(with-auth)/dashboard/admin-management/edit-permissions/[id]/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { AdminUser } from "@/lib/types";
import { getJSON, putJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { usePermissions } from "@/hooks/usePermissions";

// Grantable vocabulary — keep in sync with PERMISSION_CATEGORIES in
// ../../components/permissionsConfig.ts and the backend allowlist in
// apps/backend/src/config/adminPermissionsCatalog.js. `adminManagement` was
// removed post-#883 (everything it gated is backend SUPER_ADMIN-only now).
const ALL_PERMISSIONS = [
  { value: "userManagement", label: "User Management" },
  { value: "doctorManagement", label: "Doctor Management" },
  { value: "departmentManagement", label: "Department Management" },
  { value: "appointmentManagement", label: "Appointment Management" },
  { value: "pharmacyAdminRoutes", label: "Pharmacy Administration" },
  { value: "notificationManagement", label: "Notification Management" },
  { value: "viewAuditLogs", label: "View Audit Logs" },
];

// The backend rejects unknown permission strings fail-closed. Keep the '*'
// wildcard (legitimate, carried invisibly by most ADMIN accounts) and drop
// legacy/vestigial flags such as `adminManagement` so a save prunes them.
const KNOWN_PERMISSION_VALUES = new Set([
  "*",
  ...ALL_PERMISSIONS.map((p) => p.value),
]);

export default function EditPermissionsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const adminId = params.id;

  // Admin lifecycle is SUPER_ADMIN-only (matches the backend gate + route policy).
  const { allowed } = usePermissions({ requiredRole: "SUPER_ADMIN" });

  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAdmin = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // The backend may return either an array or { admins: [...] }
      const data = await getJSON<AdminUser[] | { admins: AdminUser[] }>(
        API_ENDPOINTS.auth.adminManagement,
      );
      const list = Array.isArray(data) ? data : (data?.admins ?? []);
      const target = list.find((a) => a.uid === adminId);

      if (!target) {
        setError("Administrator not found");
        setAdmin(null);
      } else {
        setAdmin(target);
        setSelectedPermissions(
          (target.permissions ?? []).filter((p) =>
            KNOWN_PERMISSION_VALUES.has(p),
          ),
        );
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to fetch administrator data",
      );
    } finally {
      setLoading(false);
    }
  }, [adminId]);

  useEffect(() => {
    if (!allowed) return; // gate: wait for permissions; parent layout protects auth
    void fetchAdmin();
  }, [allowed, fetchAdmin]);

  const togglePermission = (perm: string) => {
    setSelectedPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!admin) return;
    setSaving(true);
    setError(null);

    try {
      await putJSON(API_ENDPOINTS.auth.admin.updatePermissions, {
        adminId: admin.uid,
        permissions: selectedPermissions,
      });

      router.push("/dashboard/admin-management");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update permissions");
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link
            href="/dashboard/admin-management"
            className="text-primary hover:text-primary"
          >
            ← Back to Admin Management
          </Link>
        </div>
        <div className="rounded border bg-warning/10 p-4 text-warning">
          You don’t have permission to edit administrator permissions.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  if (error && !admin) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link
            href="/dashboard/admin-management"
            className="text-primary hover:text-primary"
          >
            ← Back to Admin Management
          </Link>
        </div>
        <div className="rounded border border-destructive bg-destructive/10 px-4 py-3 text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!admin) return null;

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link
          href="/dashboard/admin-management"
          className="text-primary hover:text-primary"
        >
          ← Back to Admin Management
        </Link>
      </div>

      <h1 className="mb-6 text-3xl font-bold text-foreground">
        Edit Permissions for {admin.name}
      </h1>

      <form onSubmit={handleSubmit} className="rounded-lg bg-card p-6 shadow">
        <div className="mb-6">
          <div className="mb-2 text-sm text-muted-foreground">
            Email:{" "}
            <span className="font-medium text-foreground">{admin.email}</span>
          </div>
          <div className="text-sm text-muted-foreground">
            Role:{" "}
            <span className="font-medium text-foreground">{admin.role}</span>
          </div>
        </div>

        <div className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium text-foreground">Permissions</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  setSelectedPermissions(ALL_PERMISSIONS.map((p) => p.value))
                }
                className="text-sm text-primary hover:text-primary"
                disabled={saving}
              >
                Select All
              </button>
              <span className="text-muted-foreground">|</span>
              <button
                type="button"
                onClick={() => setSelectedPermissions([])}
                className="text-sm text-primary hover:text-primary"
                disabled={saving}
              >
                Clear All
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {ALL_PERMISSIONS.map((p) => (
              <div
                key={p.value}
                className="flex items-center rounded-md border p-3 hover:bg-muted"
              >
                <input
                  type="checkbox"
                  id={p.value}
                  checked={selectedPermissions.includes(p.value)}
                  onChange={() => togglePermission(p.value)}
                  className="h-4 w-4 rounded border-input text-primary focus:ring-primary"
                  disabled={saving}
                />
                <label
                  htmlFor={p.value}
                  className="ml-3 flex-1 cursor-pointer text-sm text-foreground"
                >
                  {p.label}
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className={`rounded-md px-4 py-2 font-medium transition-colors ${
              saving
                ? "cursor-not-allowed bg-muted-foreground text-muted-foreground"
                : "bg-primary text-white hover:bg-primary/90"
            }`}
          >
            {saving ? "Saving..." : "Save Permissions"}
          </button>

          <Link
            href="/dashboard/admin-management"
            className={`text-muted-foreground hover:text-foreground ${saving ? "pointer-events-none" : ""}`}
          >
            Cancel
          </Link>
        </div>

        {error && (
          <div className="mt-4 rounded border border-destructive bg-destructive/10 px-4 py-3 text-destructive">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
