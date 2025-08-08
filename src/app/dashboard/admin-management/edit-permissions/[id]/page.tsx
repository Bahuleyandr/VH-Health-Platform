// src/app/dashboard/admin-management/edit-permissions/[id]/page.tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AdminUser } from '@/lib/types';
import { getJSON, putJSON } from '@/lib/api';
import { API_ENDPOINTS } from '@/lib/api-config';
import { usePermissions } from '@/hooks/usePermissions';

const ALL_PERMISSIONS = [
  { value: 'adminManagement', label: 'Admin Management' },
  { value: 'userManagement', label: 'User Management' },
  { value: 'doctorManagement', label: 'Doctor Management' },
  { value: 'departmentManagement', label: 'Department Management' },
  { value: 'appointmentManagement', label: 'Appointment Management' },
  { value: 'pharmacyAdminRoutes', label: 'Pharmacy Administration' },
  { value: 'notificationManagement', label: 'Notification Management' },
  { value: 'viewAuditLogs', label: 'View Audit Logs' },
];

export default function EditPermissionsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const adminId = params.id;

  // Only ADMIN with 'admin:permissions:update' (or SUPER_ADMIN) may access
  const { allowed } = usePermissions({
    requiredRole: 'ADMIN',
    requiredPermissions: ['admin:permissions:update'],
  });

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
        API_ENDPOINTS.auth.adminManagement
      );
      const list = Array.isArray(data) ? data : data?.admins ?? [];
      const target = list.find((a) => String(a.id) === adminId);

      if (!target) {
        setError('Administrator not found');
        setAdmin(null);
      } else {
        setAdmin(target);
        setSelectedPermissions(target.permissions ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch administrator data');
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
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!admin) return;
    setSaving(true);
    setError(null);

    try {
      await putJSON(API_ENDPOINTS.auth.adminManagement, {
        action: 'updatePermissions',
        adminId: Number(admin.id),
        permissions: selectedPermissions,
      });

      router.push('/dashboard/admin-management');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update permissions');
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link href="/dashboard/admin-management" className="text-blue-600 hover:text-blue-800">
            ← Back to Admin Management
          </Link>
        </div>
        <div className="rounded border bg-yellow-50 p-4 text-yellow-900">
          You don’t have permission to edit administrator permissions.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-blue-600" />
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
        <div className="rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!admin) return null;

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link href="/dashboard/admin-management" className="text-blue-600 hover:text-blue-800">
          ← Back to Admin Management
        </Link>
      </div>

      <h1 className="mb-6 text-3xl font-bold text-gray-900">
        Edit Permissions for {admin.name}
      </h1>

      <form onSubmit={handleSubmit} className="rounded-lg bg-white p-6 shadow">
        <div className="mb-6">
          <div className="mb-2 text-sm text-gray-600">
            Email: <span className="font-medium text-gray-900">{admin.email}</span>
          </div>
          <div className="text-sm text-gray-600">
            Role: <span className="font-medium text-gray-900">{admin.role}</span>
          </div>
        </div>

        <div className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">Permissions</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedPermissions(ALL_PERMISSIONS.map((p) => p.value))}
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

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {ALL_PERMISSIONS.map((p) => (
              <div
                key={p.value}
                className="flex items-center rounded-md border p-3 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  id={p.value}
                  checked={selectedPermissions.includes(p.value)}
                  onChange={() => togglePermission(p.value)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  disabled={saving}
                />
                <label htmlFor={p.value} className="ml-3 flex-1 cursor-pointer text-sm text-gray-900">
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
              saving ? 'cursor-not-allowed bg-gray-400 text-gray-200' : 'bg-blue-600 text-white hover:bg-blue-700'
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
          <div className="mt-4 rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700">
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
