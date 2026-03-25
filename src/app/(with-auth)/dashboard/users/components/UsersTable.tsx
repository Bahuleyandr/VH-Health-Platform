// src/app/(with-auth)/dashboard/users/components/UsersTable.tsx
"use client";

import { useEffect, useRef } from "react";
import type { User } from "@/lib/types";
import { useSelection } from "@/hooks/useSelection";
import { BulkActions } from "@/components/BulkActions";
import { fetchAdminAPI } from "@/lib/api";
import toast from "react-hot-toast";

interface UsersTableProps {
  users: User[];
  onUserUpdated: () => void;
}

// Type guard to safely read optional "role" without using `any`
function hasRole(u: unknown): u is { role: string } {
  return (
    typeof u === "object" &&
    u !== null &&
    typeof (u as Record<string, unknown>).role === "string"
  );
}

export function UsersTable({ users, onUserUpdated }: UsersTableProps) {
  const {
    selectedIds,
    selectedCount,
    toggleSelection,
    toggleAll,
    clearSelection,
    isSelected,
    isAllSelected,
    isPartiallySelected,
  } = useSelection(users);

  // Proper "indeterminate" handling via ref
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate =
        !!isPartiallySelected && !isAllSelected;
    }
  }, [isPartiallySelected, isAllSelected]);

  const handleBulkDelete = async () => {
    const promises = selectedIds.map((id) =>
      fetchAdminAPI(`/users/${id}`, { method: "DELETE" }),
    );
    await Promise.all(promises);
    onUserUpdated();
    clearSelection();
    toast.success(`Deleted ${selectedCount} users`);
  };

  const handleBulkExport = () => {
    const selectedUsers = users.filter((user) => selectedIds.includes(user.id));
    const csv = convertToCSV(selectedUsers);
    downloadCSV(csv, "users-export.csv");
    toast.success(`Exported ${selectedCount} users`);
  };

  const handleBulkActivate = async () => {
    const promises = selectedIds.map((id) =>
      fetchAdminAPI(`/users/${id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: true }),
      }),
    );
    await Promise.all(promises);
    toast.success(`Activated ${selectedCount} users`);
    onUserUpdated();
    clearSelection();
  };

  const handleBulkDeactivate = async () => {
    const promises = selectedIds.map((id) =>
      fetchAdminAPI(`/users/${id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: false }),
      }),
    );
    await Promise.all(promises);
    toast.success(`Deactivated ${selectedCount} users`);
    onUserUpdated();
    clearSelection();
  };

  return (
    <>
      <div className="bg-white dark:bg-card shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-border dark:divide-border">
          <thead className="bg-muted dark:bg-background">
            <tr>
              <th scope="col" className="px-6 py-3 text-left">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 text-primary rounded border-input focus:ring-primary"
                />
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground dark:text-muted-foreground uppercase tracking-wider">
                Role
              </th>
              <th className="relative px-6 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-card divide-y divide-border dark:divide-border">
            {users.map((user) => (
              <tr
                key={user.id}
                className={`hover:bg-muted dark:hover:bg-muted ${isSelected(user.id) ? "bg-primary/10 dark:bg-primary/20" : ""}`}
              >
                <td className="px-6 py-4 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={isSelected(user.id)}
                    onChange={() => toggleSelection(user.id)}
                    className="h-4 w-4 text-primary rounded border-input focus:ring-primary"
                  />
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-foreground dark:text-white">
                    {user.name}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-muted-foreground dark:text-muted-foreground">
                    {user.email}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      user.is_active
                        ? "bg-success/10 text-success dark:bg-success/20 dark:text-success/70"
                        : "bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive/60"
                    }`}
                  >
                    {user.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground dark:text-muted-foreground">
                  {hasRole(user) ? user.role : "User"}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BulkActions
        selectedCount={selectedCount}
        onDelete={handleBulkDelete}
        onExport={handleBulkExport}
        onClearSelection={clearSelection}
        actions={[
          {
            label: "Activate",
            onClick: handleBulkActivate,
            variant: "primary",
            icon: (
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            ),
          },
          {
            label: "Deactivate",
            onClick: handleBulkDeactivate,
            variant: "default",
            icon: (
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            ),
          },
        ]}
      />
    </>
  );
}

// Utility functions
function convertToCSV(users: User[]): string {
  const headers = ["ID", "Name", "Email", "Status", "Created At"];
  const rows = users.map((user) => [
    user.id,
    user.name,
    user.email,
    user.is_active ? "Active" : "Inactive",
    new Date(user.created_at).toLocaleDateString(),
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
