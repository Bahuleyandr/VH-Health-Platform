'use client';

import { useState } from "react";
import { useDepartments } from "@/hooks/api-hooks";
import { CreateDepartmentForm } from "./components/CreateDepartmentForm";
import { DepartmentsTable } from "./components/DepartmentsTable";
import { Spinner } from "@/components/ui/spinner";
import toast from 'react-hot-toast';

export default function DepartmentsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const { data, isLoading, error, refetch } = useDepartments();

  const departments = data?.departments || data || [];

  // Filter departments based on search term
  const filteredDepartments = departments.filter(dept =>
    dept.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (dept.description && dept.description.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg p-4">
        <h3 className="font-semibold mb-1">Error Loading Departments</h3>
        <p>{error instanceof Error ? error.message : 'Failed to load departments'}</p>
        <button
          onClick={() => {
            toast.promise(refetch(), {
              loading: 'Refreshing departments...',
              success: 'Departments refreshed!',
              error: 'Failed to refresh departments'
            });
          }}
          className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Department Management</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Manage hospital departments and their information
        </p>
      </div>

      {/* Search Bar */}
      <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search departments by name or description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
          </div>
          <div className="text-sm text-gray-500">
            {filteredDepartments.length} of {departments.length} departments
          </div>
        </div>
      </div>

      {/* Create Department Form - Updated to use React Query */}
      <CreateDepartmentForm />

      {/* Departments Table - No changes needed, already compatible */}
      <DepartmentsTable 
        departments={filteredDepartments} 
        onDepartmentUpdated={refetch}
        onDepartmentDeleted={refetch}
      />
    </div>
  );
}