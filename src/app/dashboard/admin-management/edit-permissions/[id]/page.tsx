// src/app/dashboard/admin-management/edit-permissions/[id]/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchAdminAPI } from '@/lib/api';
import { AdminUser } from '@/lib/types';
import Link from 'next/link';

const ALL_PERMISSIONS = [
  { value: "adminManagement", label: "Admin Management" },
  { value: "userManagement", label: "User Management" },
  { value: "doctorManagement", label: "Doctor Management" },
  { value: "departmentManagement", label: "Department Management" },
  { value: "appointmentManagement", label: "Appointment Management" },
  { value: "pharmacyAdminRoutes", label: "Pharmacy Administration" },
  { value: "notificationManagement", label: "Notification Management" },
  { value: "viewAuditLogs", label: "View Audit Logs" }
];

export default function EditPermissionsPage() {
  const params = useParams();
  const router = useRouter();
  const adminId = params.id as string;
  
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAdminData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Fetch all admins and find the specific one
        const response = await fetchAdminAPI('/auth/admin/list');
        const admins: AdminUser[] = response.admins || [];
        const adminToEdit = admins.find(a => a.id.toString() === adminId);
        
        if (!adminToEdit) {
          setError('Administrator not found');
        } else {
          setAdmin(adminToEdit);
          setSelectedPermissions(adminToEdit.permissions || []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch administrator data');
      } finally {
        setLoading(false);
      }
    };

    fetchAdminData();
  }, [adminId]);

  const handlePermissionToggle = (permission: string) => {
    setSelectedPermissions(prev => {
      if (prev.includes(permission)) {
        return prev.filter(p => p !== permission);
      } else {
        return [...prev, permission];
      }
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await fetchAdminAPI('/auth/admin/update-permissions', {
        method: 'PUT',
        body: JSON.stringify({
          adminId: parseInt(adminId),
          permissions: selectedPermissions
        }),
      });

      // Redirect back to admin management page
      router.push('/dashboard/admin-management');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update permissions";
      setError(errorMessage);
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error && !admin) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link href="/dashboard/admin-management" className="text-blue-600 hover:text-blue-800">
            ← Back to Admin Management
          </Link>
        </div>
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      </div>
    );
  }

  if (!admin) {
    return null;
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link href="/dashboard/admin-management" className="text-blue-600 hover:text-blue-800">
          ← Back to Admin Management
        </Link>
      </div>
      
      <h1 className="text-3xl font-bold text-gray-900 mb-6">
        Edit Permissions for {admin.name}
      </h1>
      
      <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6">
        <div className="mb-6">
          <div className="text-sm text-gray-600 mb-2">
            Email: <span className="font-medium text-gray-900">{admin.email}</span>
          </div>
          <div className="text-sm text-gray-600">
            Role: <span className="font-medium text-gray-900">{admin.role}</span>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-medium text-gray-900">Permissions</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedPermissions(ALL_PERMISSIONS.map(p => p.value))}
                className="text-sm text-blue-600 hover:text-blue-800"
                disabled={saving}
              >
                Select All
              </button>
              <span className="text-gray-400">|</span>
              <button
                type="button"
                onClick={() => setSelectedPermissions([])}
                className="text-sm text-blue-600 hover:text-blue-800"
                disabled={saving}
              >
                Clear All
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {ALL_PERMISSIONS.map(permission => (
              <div key={permission.value} className="flex items-center p-3 border rounded-md hover:bg-gray-50">
                <input
                  type="checkbox"
                  id={permission.value}
                  checked={selectedPermissions.includes(permission.value)}
                  onChange={() => handlePermissionToggle(permission.value)}
                  className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  disabled={saving}
                />
                <label 
                  htmlFor={permission.value} 
                  className="ml-3 text-sm text-gray-900 cursor-pointer flex-1"
                >
                  {permission.label}
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            type="submit" 
            disabled={saving} 
            className={`px-4 py-2 rounded-md font-medium transition-colors ${
              saving 
                ? 'bg-gray-400 text-gray-200 cursor-not-allowed' 
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {saving ? 'Saving...' : 'Save Permissions'}
          </button>
          <Link 
            href="/dashboard/admin-management" 
            className={`text-gray-500 hover:text-gray-700 ${saving ? 'pointer-events-none' : ''}`}
          >
            Cancel
          </Link>
        </div>

        {error && (
          <div className="mt-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}