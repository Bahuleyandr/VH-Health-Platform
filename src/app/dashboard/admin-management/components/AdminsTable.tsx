// src/app/dashboard/admin-management/components/AdminsTable.tsx
'use client';

import { AdminUser } from "@/lib/types";
import Link from "next/link";
import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

interface AdminsTableProps {
  admins: AdminUser[];
  onAdminUpdated?: () => void;
}

export function AdminsTable({ admins, onAdminUpdated }: AdminsTableProps) {
  const [updatingAdminId, setUpdatingAdminId] = useState<number | null>(null);

  const handleToggleStatus = async (admin: AdminUser) => {
    const confirmMessage = admin.is_active 
      ? `Are you sure you want to deactivate ${admin.name}?`
      : `Are you sure you want to reactivate ${admin.name}?`;
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    setUpdatingAdminId(admin.id);
    
    try {
      if (admin.is_active) {
        // Deactivate admin
        await fetchAdminAPI('/auth/admin/deactivate-admin', {
          method: 'PUT',
          body: JSON.stringify({
            adminId: admin.id,
            reason: 'Deactivated via admin portal'
          }),
        });
      } else {
        // Reactivate admin
        await fetchAdminAPI('/auth/admin/reactivate-admin', {
          method: 'PUT',
          body: JSON.stringify({
            adminId: admin.id
          }),
        });
      }
      
      // Notify parent to refresh the list
      if (onAdminUpdated) {
        onAdminUpdated();
      }
    } catch (error) {
      console.error("Failed to toggle admin status:", error);
      alert("Failed to update admin status. Please try again.");
    } finally {
      setUpdatingAdminId(null);
    }
  };

  const formatLastLogin = (lastLogin: string | null) => {
    if (!lastLogin) return { text: 'Never', className: 'text-gray-400' };
    
    const date = new Date(lastLogin);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    let text = date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    let className = 'text-gray-500';
    
    if (diffDays === 0) {
      text = 'Today';
      className = 'text-green-600 font-medium';
    } else if (diffDays === 1) {
      text = 'Yesterday';
      className = 'text-blue-600';
    } else if (diffDays <= 7) {
      text = `${diffDays} days ago`;
      className = 'text-blue-600';
    } else if (diffDays > 30) {
      className = 'text-orange-600';
    }
    
    return { text, className, fullDate: date.toLocaleString() };
  };

  const getPermissionsSummary = (permissions: string[]) => {
    if (permissions.length === 0) return "No permissions";
    if (permissions.length <= 3) return permissions.join(", ");
    return `${permissions.slice(0, 3).join(", ")} +${permissions.length - 3} more`;
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Administrator
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Role
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Permissions
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Last Login
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {admins.map((admin) => (
              <tr key={admin.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{admin.name}</div>
                    <div className="text-sm text-gray-500">{admin.email}</div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">{admin.role}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-gray-600">
                    {getPermissionsSummary(admin.permissions)}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    admin.is_active 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-red-100 text-red-800'
                  }`}>
                    {admin.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {(() => {
                    const loginInfo = formatLastLogin(admin.last_login);
                    return (
                      <span 
                        className={`text-sm ${loginInfo.className}`}
                        title={loginInfo.fullDate}
                      >
                        {loginInfo.text}
                      </span>
                    );
                  })()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex items-center gap-3">
                    <Link 
                      href={`/dashboard/admin-management/edit-permissions/${admin.id}`} 
                      className="text-blue-600 hover:text-blue-900 transition-colors"
                    >
                      Edit Permissions
                    </Link>
                    <button
                      onClick={() => handleToggleStatus(admin)}
                      disabled={updatingAdminId === admin.id}
                      className={`${
                        updatingAdminId === admin.id
                          ? 'text-gray-400 cursor-not-allowed'
                          : admin.is_active 
                            ? 'text-red-600 hover:text-red-900' 
                            : 'text-green-600 hover:text-green-900'
                      } transition-colors`}
                    >
                      {updatingAdminId === admin.id 
                        ? 'Updating...' 
                        : admin.is_active ? 'Deactivate' : 'Reactivate'
                      }
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}