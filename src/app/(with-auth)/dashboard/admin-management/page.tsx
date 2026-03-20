// src/app/(with-auth)/dashboard/admin-management/page.tsx
"use client";

import { RequirePermissions } from "@/components/auth/RequirePermissions";
import { getJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import type { AdminUser } from "@/lib/types";
import { useEffect, useState, useCallback } from "react";

import { AdminsTable } from "./components/AdminsTable";
import { AdminStats } from "./components/AdminStats";
import { CreateAdminForm } from "./components/CreateAdminForm";
import { PermissionsMatrix } from "./components/PermissionsMatrix";


export default function AdminManagementPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAdmins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Backend may return either an array or an object with { admins: [...] }
      const data = await getJSON<AdminUser[] | { admins: AdminUser[] }>(
        API_ENDPOINTS.auth.adminManagement,
      );
      const list = Array.isArray(data)
        ? data
        : ((data as { admins?: AdminUser[] })?.admins ?? []);

      setAdmins(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch administrators",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAdmins();
  }, [fetchAdmins]);

  const handleAdminCreated = () => void fetchAdmins();
  const handleAdminUpdated = () => void fetchAdmins();

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 text-3xl font-bold text-gray-900">
        Administrator Management
      </h1>

      <AdminStats admins={admins} />

      {/* Only show creation UI to authorized users */}
      <RequirePermissions
        requiredRole="ADMIN"
        requiredPermissions={["admin:create"]}
      >
        <CreateAdminForm onAdminCreated={handleAdminCreated} />
      </RequirePermissions>

      <div className="mt-8">
        <h2 className="mb-4 text-xl font-semibold text-gray-800">
          Current Administrators
        </h2>

        {admins.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <p className="text-gray-500">No administrators found.</p>
          </div>
        ) : (
          <AdminsTable admins={admins} onAdminUpdated={handleAdminUpdated} />
        )}

        <div className="mt-8">
          <PermissionsMatrix admins={admins} />
        </div>
      </div>
    </div>
  );
}
