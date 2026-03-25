// src/components/BulkActions.tsx
"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { DownloadIcon, TrashIcon } from "@/components/icons";

interface BulkActionsProps {
  selectedCount: number;
  onDelete: () => Promise<void>;
  onExport: () => void;
  onClearSelection: () => void;
  actions?: Array<{
    label: string;
    onClick: () => void | Promise<void>;
    variant?: "primary" | "danger" | "default";
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
    if (
      !window.confirm(`Are you sure you want to delete ${selectedCount} items?`)
    ) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete();
      toast.success(`Successfully deleted ${selectedCount} items`);
      onClearSelection();
    } catch {
      toast.error("Failed to delete items");
    } finally {
      setIsDeleting(false);
    }
  };

  const defaultActions = [
    {
      label: "Export",
      onClick: onExport,
      variant: "default" as const,
      icon: <DownloadIcon className="w-4 h-4 mr-2" />,
    },
    {
      label: isDeleting ? "Deleting..." : "Delete",
      onClick: handleDelete,
      variant: "danger" as const,
      icon: <TrashIcon className="w-4 h-4 mr-2" />,
    },
  ];

  const allActions = [...actions, ...defaultActions];

  const getButtonClass = (variant: string) => {
    switch (variant) {
      case "primary":
        return "bg-primary text-white hover:bg-primary/90";
      case "danger":
        return "bg-destructive text-white hover:bg-destructive/90";
      default:
        return "bg-foreground text-white hover:bg-muted";
    }
  };

  return (
    <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
      <div className="bg-white dark:bg-card shadow-lg rounded-lg p-4 flex items-center gap-4 border border-border dark:border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground dark:text-foreground">
            {selectedCount} selected
          </span>
          <button
            onClick={onClearSelection}
            className="text-sm text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-muted-foreground"
          >
            Clear
          </button>
        </div>

        <div className="h-6 w-px bg-muted dark:bg-foreground" />

        <div className="flex items-center gap-2">
          {allActions.map((action, index) => (
            <button
              key={index}
              onClick={action.onClick}
              disabled={isDeleting}
              className={`px-3 py-1.5 text-sm font-medium rounded-md flex items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${getButtonClass(action.variant || "default")}`}
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
