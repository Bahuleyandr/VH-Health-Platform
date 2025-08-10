// src/app/dashboard/users/components/UsersTable.tsx
'use client';

import { useEffect, useRef } from 'react';
import type { User } from '@/lib/types';
import { useSelection } from '@/hooks/useSelection';
import { BulkActions } from '@/components/BulkActions';
import { fetchAdminAPI } from '@/lib/api';
import toast from 'react-hot-toast';

interface UsersTableProps {
  users: User[];
  onUserUpdated: () => void;
}

// Type guard to safely read optional "role" without using `any`
function hasRole(u: unknown): u is { role: string } {
  return typeof u === 'object' && u !== null && typeof (u as Record<string, unknown>).role === 'string';
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
      headerCheckboxRef.current.indeterminate = !!isPartiallySelected && !isAllSelected;
    }
  }, [isPartiallySelected, isAllSelected]);

  const handleBulkDelete = async () => {
    const promises = selectedIds.map(id => fetchAdminAPI(`/users/${id}`, { method: 'DELETE' }));
    await Promise.all(promises);
    onUserUpdated();
    clearSelection();
    toast.success(`Deleted ${selectedCount} users`);
  };

  const handleBulkExport = () => {
    const selectedUsers = users.filter(user => selectedIds.includes(user.id));
    const csv = convertToCSV(selectedUsers);
    downloadCSV(csv, 'users-export.csv');
    toast.success(`Exported ${selectedCount} users`);
  };

  const handleBulkActivate = async () => {
    const promises = selectedIds.map(id =>
      fetchAdminAPI(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: true }),
      })
    );
    await Promise.all(promises);
    toast.success(`Activated ${selectedCount} users`);
    onUserUpdated();
    clearSelection();
  };

  const handleBulkDeactivate = async () => {
    const promises = selectedIds.map(id =>
      fetchAdminAPI(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: false }),
      })
    );
    await Promise.all(promises);
    toast.success(`Deactivated ${selectedCount} users`);
    onUserUpdated();
    clearSelection();
  };

  return (
    <>
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="px-6 py-3 text-left">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Role
              </th>
              <th className="relative px-6 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {users.map((user) => (
              <tr
                key={user.id}
                className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${isSelected(user.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
              >
                <td className="px-6 py-4 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={isSelected(user.id)}
                    onChange={() => toggleSelection(user.id)}
                    className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{user.name}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-500 dark:text-gray-400">{user.email}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                      user.is_active
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
                    }`}
                  >
                    {user.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {hasRole(user) ? user.role : 'User'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <button className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400">Edit</button>
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
            label: 'Activate',
            onClick: handleBulkActivate,
            variant: 'primary',
            icon: (
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ),
          },
          {
            label: 'Deactivate',
            onClick: handleBulkDeactivate,
            variant: 'default',
            icon: (
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
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
  const headers = ['ID', 'Name', 'Email', 'Status', 'Created At'];
  const rows = users.map(user => [
    user.id,
    user.name,
    user.email,
    user.is_active ? 'Active' : 'Inactive',
    new Date(user.created_at).toLocaleDateString(),
  ]);

  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
