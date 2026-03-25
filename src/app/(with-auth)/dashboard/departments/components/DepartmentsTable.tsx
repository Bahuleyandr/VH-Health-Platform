// src/app/(with-auth)/dashboard/departments/components/DepartmentsTable.tsx
"use client";

import { Department } from "@/lib/types";
import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { EditDepartmentModal } from "./EditDepartmentModal";
import { HospitalIcon } from "@/components/icons";

interface DepartmentsTableProps {
  departments: Department[];
  onDepartmentUpdated: () => void;
  onDepartmentDeleted: () => void;
}

export function DepartmentsTable({
  departments,
  onDepartmentUpdated,
  onDepartmentDeleted,
}: DepartmentsTableProps) {
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(
    null,
  );
  const [deletingId, setDeletingId] = useState<number | null>(null); // ← number, not string

  const handleDelete = async (department: Department) => {
    if (
      !window.confirm(
        `Are you sure you want to delete the "${department.name}" department? This action cannot be undone.`,
      )
    ) {
      return;
    }

    try {
      setDeletingId(department.id);
      await fetchAdminAPI(`/departments/${department.id}`, {
        method: "DELETE",
      });
      onDepartmentDeleted();
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Failed to delete department",
      );
    } finally {
      setDeletingId(null);
    }
  };

  if (departments.length === 0) {
    return (
      <div className="bg-white dark:bg-card p-8 rounded-lg shadow text-center">
        <HospitalIcon className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-2 text-sm font-medium text-foreground dark:text-white">
          No departments found
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Get started by creating a new department.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white dark:bg-card shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-border dark:divide-border">
          <thead className="bg-muted dark:bg-background">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Department Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Description
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Created At
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-border">
            {departments.map((department) => (
              <tr key={department.id} className="hover:bg-muted">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-foreground">
                    {department.name}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-muted-foreground">
                    {department.description || "No description provided"}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-muted-foreground">
                    {department.created_at
                      ? new Date(department.created_at).toLocaleDateString()
                      : "N/A"}
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
                    className="text-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deletingId === department.id ? "Deleting..." : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
