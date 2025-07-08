// src/app/dashboard/departments/components/DepartmentsTable.tsx
'use client';

import { Department } from "@/lib/types";
import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { EditDepartmentModal } from "./EditDepartmentModal";

interface DepartmentsTableProps {
  departments: Department[];
  onDepartmentUpdated: () => void;
  onDepartmentDeleted: () => void;
}

export function DepartmentsTable({ 
  departments, 
  onDepartmentUpdated, 
  onDepartmentDeleted 
}: DepartmentsTableProps) {
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (department: Department) => {
    if (!window.confirm(`Are you sure you want to delete the "${department.name}" department? This action cannot be undone.`)) {
      return;
    }

    try {
      setDeletingId(department.id);
      await fetchAdminAPI(`/departments/${department.id}`, {
        method: 'DELETE',
      });
      onDepartmentDeleted();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete department');
    } finally {
      setDeletingId(null);
    }
  };

  if (departments.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow text-center">
        <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No departments found</h3>
        <p className="mt-1 text-sm text-gray-500">
          Get started by creating a new department.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Department Name
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Description
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Created At
              </th>
              <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {departments.map((department) => (
              <tr key={department.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">{department.name}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-gray-500">
                    {department.description || 'No description provided'}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-500">
                    {department.created_at ? new Date(department.created_at).toLocaleDateString() : 'N/A'}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button
                    onClick={() => setEditingDepartment(department)}
                    className="text-indigo-600 hover:text-indigo-900 mr-4"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(department)}
                    disabled={deletingId === department.id}
                    className="text-red-600 hover:text-red-900 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deletingId === department.id ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit Modal */}
      {editingDepartment && (
        <EditDepartmentModal
          department={editingDepartment}
          onClose={() => setEditingDepartment(null)}
          onSuccess={() => {
            setEditingDepartment(null);
            onDepartmentUpdated();
          }}
        />
      )}
    </>
  );
}