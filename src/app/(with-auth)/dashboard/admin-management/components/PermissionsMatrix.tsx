// src/app/dashboard/admin-management/components/PermissionsMatrix.tsx
"use client";

import { useState, useMemo } from "react";
import type { AdminUser } from "@/lib/types";

interface PermissionsMatrixProps {
  admins: AdminUser[];
}

const PERMISSION_LABELS = {
  adminManagement: "Admin Mgmt",
  userManagement: "User Mgmt",
  doctorManagement: "Doctor Mgmt",
  departmentManagement: "Dept Mgmt",
  appointmentManagement: "Appt Mgmt",
  pharmacyAdminRoutes: "Pharmacy",
  notificationManagement: "Notifications",
  viewAuditLogs: "Audit Logs",
} as const;

type PermissionKey = keyof typeof PERMISSION_LABELS;

export function PermissionsMatrix({ admins }: PermissionsMatrixProps) {
  const [showMatrix, setShowMatrix] = useState(false);

  const allPermissions: PermissionKey[] = useMemo(
    () => Object.keys(PERMISSION_LABELS) as PermissionKey[],
    [],
  );

  if (!showMatrix) {
    return (
      <div className="mt-6">
        <button
          onClick={() => setShowMatrix(true)}
          className="text-blue-600 hover:text-blue-800 font-medium text-sm"
        >
          Show Permissions Matrix →
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-900">
          Permissions Matrix
        </h3>
        <button
          onClick={() => setShowMatrix(false)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Hide Matrix
        </button>
      </div>

      <div className="overflow-hidden rounded-lg bg-white shadow">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 bg-gray-50"
                >
                  Admin
                </th>
                {allPermissions.map((permission) => (
                  <th
                    key={permission}
                    scope="col"
                    className="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500"
                    title={permission}
                  >
                    {PERMISSION_LABELS[permission]}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-200 bg-white">
              {admins.map((admin) => {
                const isSuperAdmin = admin.role === "SUPER_ADMIN";
                const perms = Array.isArray(admin.permissions)
                  ? admin.permissions
                  : [];

                return (
                  <tr key={admin.id} className="hover:bg-gray-50">
                    <td className="sticky left-0 z-10 whitespace-nowrap px-6 py-4 bg-white">
                      <div className="text-sm font-medium text-gray-900">
                        {admin.name}
                      </div>
                      <div className="text-xs text-gray-500">{admin.role}</div>
                    </td>

                    {allPermissions.map((permission) => {
                      const has = isSuperAdmin || perms.includes(permission);
                      return (
                        <td
                          key={permission}
                          className="whitespace-nowrap px-3 py-4 text-center"
                        >
                          {has ? (
                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-100">
                              <svg
                                className="h-4 w-4 text-green-600"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            </span>
                          ) : (
                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-100">
                              <svg
                                className="h-4 w-4 text-gray-400"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 text-sm text-gray-600">
        <p className="mb-2 font-medium">Permission Legend:</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {Object.entries(PERMISSION_LABELS).map(([key, label]) => (
            <div key={key} className="text-xs">
              <span className="font-medium">{label}:</span> {key}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
