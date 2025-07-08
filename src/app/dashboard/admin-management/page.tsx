'use client';

// src/app/dashboard/admin-management/page.tsx
import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { AdminUser } from "@/lib/types";
import { CreateAdminForm } from "./components/CreateAdminForm";
import { AdminsTable } from "./components/AdminsTable";
import { AdminStats } from "./components/AdminStats";
import { PermissionsMatrix } from "./components/PermissionsMatrix";

export default function AdminManagementPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAdmins = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetchAdminAPI('/auth/admin/list');
      setAdmins(response.admins || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch administrators');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdmins();
  }, []);

  const handleAdminCreated = () => {
    // Refresh the list after creating a new admin
    fetchAdmins();
  };

  const handleAdminUpdated = () => {
    // Refresh the list after updating an admin
    fetchAdmins();
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
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Administrator Management</h1>
      
      <AdminStats admins={admins} />
      
      <CreateAdminForm onAdminCreated={handleAdminCreated} />

      <div className="mt-8">
        <h2 className="text-xl font-semibold text-gray-800 mb-4">Current Administrators</h2>
        
        {admins.length === 0 ? (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No administrators found.</p>
          </div>
        ) : (
          <AdminsTable admins={admins} onAdminUpdated={handleAdminUpdated} />
        )}
        
        <PermissionsMatrix admins={admins} />
      </div>
    </div>
  );
}