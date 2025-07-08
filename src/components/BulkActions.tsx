// ===== FILE 1: src/components/BulkActions.tsx =====
'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';

interface BulkActionsProps {
  selectedCount: number;
  onDelete: () => Promise<void>;
  onExport: () => void;
  onClearSelection: () => void;
  actions?: Array<{
    label: string;
    onClick: () => void | Promise<void>;
    variant?: 'primary' | 'danger' | 'default';
    icon?: React.ReactNode;
  }>;
}

export function BulkActions({
  selectedCount,
  onDelete,
  onExport,
  onClearSelection,
  actions = [],
}: BulkActionsProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  if (selectedCount === 0) return null;

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete ${selectedCount} items?`)) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete();
      toast.success(`Successfully deleted ${selectedCount} items`);
      onClearSelection();
    } catch (error) {
      toast.error('Failed to delete items');
    } finally {
      setIsDeleting(false);
    }
  };

  const defaultActions = [
    {
      label: 'Export',
      onClick: onExport,
      variant: 'default' as const,
      icon: (
        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      ),
    },
    {
      label: isDeleting ? 'Deleting...' : 'Delete',
      onClick: handleDelete,
      variant: 'danger' as const,
      icon: (
        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      ),
    },
  ];

  const allActions = [...actions, ...defaultActions];

  const getButtonClass = (variant: string) => {
    switch (variant) {
      case 'primary':
        return 'bg-blue-600 text-white hover:bg-blue-700';
      case 'danger':
        return 'bg-red-600 text-white hover:bg-red-700';
      default:
        return 'bg-gray-600 text-white hover:bg-gray-700';
    }
  };

  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
      <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-4 flex items-center gap-4 border border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {selectedCount} selected
          </span>
          <button
            onClick={onClearSelection}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear
          </button>
        </div>
        
        <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
        
        <div className="flex items-center gap-2">
          {allActions.map((action, index) => (
            <button
              key={index}
              onClick={action.onClick}
              disabled={isDeleting}
              className={`px-3 py-1.5 text-sm font-medium rounded-md flex items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${getButtonClass(action.variant || 'default')}`}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===== FILE 2: src/hooks/useSelection.ts =====
import { useState, useCallback } from 'react';

export function useSelection<T extends { id: string | number }>(items: T[] = []) {
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set());

  const toggleSelection = useCallback((id: string | number) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === items.length) {
        return new Set();
      } else {
        return new Set(items.map(item => item.id));
      }
    });
  }, [items]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback((id: string | number) => {
    return selectedIds.has(id);
  }, [selectedIds]);

  const isAllSelected = items.length > 0 && selectedIds.size === items.length;
  const isPartiallySelected = selectedIds.size > 0 && selectedIds.size < items.length;

  return {
    selectedIds: Array.from(selectedIds),
    selectedCount: selectedIds.size,
    toggleSelection,
    toggleAll,
    clearSelection,
    isSelected,
    isAllSelected,
    isPartiallySelected,
  };
}

// ===== FILE 3: Updated Users Table with Bulk Actions =====
// src/app/dashboard/users/components/UsersTable.tsx
'use client';

import { User } from '@/lib/types';
import { useSelection } from '@/hooks/useSelection';
import { BulkActions } from '@/components/BulkActions';
import { fetchAdminAPI } from '@/lib/api';
import toast from 'react-hot-toast';

interface UsersTableProps {
  users: User[];
  onUserUpdated: () => void;
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

  const handleBulkDelete = async () => {
    const promises = selectedIds.map(id => 
      fetchAdminAPI(`/users/${id}`, { method: 'DELETE' })
    );
    
    await Promise.all(promises);
    onUserUpdated();
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
        body: JSON.stringify({ isActive: true })
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
        body: JSON.stringify({ isActive: false })
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
                  type="checkbox"
                  checked={isAllSelected}
                  indeterminate={isPartiallySelected}
                  onChange={toggleAll}
                  className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Name
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Email
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Status
              </th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Role
              </th>
              <th scope="col" className="relative px-6 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {users.map((user) => (
              <tr
                key={user.id}
                className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${
                  isSelected(user.id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
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
                  <div className="text-sm font-medium text-gray-900 dark:text-white">
                    {user.name}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {user.email}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    user.isActive
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
                  }`}>
                    {user.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {user.role || 'User'}
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
    user.isActive ? 'Active' : 'Inactive',
    new Date(user.createdAt).toLocaleDateString(),
  ]);
  
  return [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');
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