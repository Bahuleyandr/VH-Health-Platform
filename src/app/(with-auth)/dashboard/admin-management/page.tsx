// src/app/(with-auth)/dashboard/admin-management/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { getJSON } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";
import { normalizeList } from "@/lib/normalize-response";
import type { AdminUser } from "@/lib/types";
<<<<<<< HEAD
import { CreateAdminForm } from "./components/CreateAdminForm";
=======
import { useQuery, useQueryClient } from "@tanstack/react-query";

>>>>>>> 7ca9048 (Comprehensive code review fixes: security, consistency, UX, and a11y)
import { AdminsTable } from "./components/AdminsTable";
import { AdminStats } from "./components/AdminStats";
import { PermissionsMatrix } from "./components/PermissionsMatrix";
<<<<<<< HEAD
import { RequirePermissions } from "@/components/auth/RequirePermissions";
=======

const normalizeAdmins = normalizeList<AdminUser>("admins");
>>>>>>> 7ca9048 (Comprehensive code review fixes: security, consistency, UX, and a11y)

export default function AdminManagementPage() {
  const queryClient = useQueryClient();

  const {
    data: admins = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admins"],
    queryFn: async () => {
      const data = await getJSON<unknown>(API_ENDPOINTS.auth.adminManagement);
      return normalizeAdmins(data);
    },
  });

  const handleAdminCreated = () =>
    queryClient.invalidateQueries({ queryKey: ["admins"] });
  const handleAdminUpdated = () =>
    queryClient.invalidateQueries({ queryKey: ["admins"] });

  if (isLoading) {
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
          Error: {error instanceof Error ? error.message : "Failed to fetch administrators"}
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
