// src/app/dashboard/admin-management/components/PermissionsMatrix.tsx
'use client';

import { AdminUser } from "@/lib/types";
import { useState } from "react";

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
  viewAuditLogs: "Audit Logs"
};

export function PermissionsMatrix({ admins }: PermissionsMatrixProps) {
  const [showMatrix, setShowMatrix] = useState(false);
  
  const allPermissions = Object.keys(PERMISSION_LABELS);

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
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium text-gray-900">Permissions Matrix</h3>
        <button
          onClick={() => setShowMatrix(false)}
          className="text-gray-500 hover:text-gray-700 text-sm"
        >
          Hide Matrix
        </button>
      </div>
      
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-10">
                  Admin
                </th>
                {allPermissions.map(permission => (
                  <th 
                    key={permission} 
                    className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                    title={permission}
                  >
                    {PERMISSION_LABELS[permission as keyof typeof PERMISSION_LABELS]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {admins.map((admin) => (
                <tr key={admin.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 sticky left-0 bg-white z-10">
                    <div>
                      <div>{admin.name}</div>
                      <div className="text-xs text-gray-500">{admin.role}</div>
                    </div>
                  </td>
                  {allPermissions.map(permission => (
                    <td key={permission} className="px-3 py-4 whitespace-nowrap text-center">
                      {admin.permissions.includes(permission) ? (
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-green-100 rounded-full">
                          <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center w-6 h-6 bg-gray-100 rounded-full">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      
      <div className="mt-4 text-sm text-gray-600">
        <p className="font-medium mb-2">Permission Legend:</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
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