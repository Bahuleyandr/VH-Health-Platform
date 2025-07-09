// src/components/BulkActions.tsx =====
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