// src/app/(with-auth)/dashboard/departments/components/EditDepartmentModal.tsx
"use client";

import { useState, useEffect } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import { CloseIcon } from "@/components/icons";
import { toast } from "sonner";

interface EditDepartmentModalProps {
  department: Department;
  onClose: () => void;
  // Returns void or Promise<void> — the table awaits it so the row reflects
  // the new description before the modal closes.
  onSuccess: () => void | Promise<void>;
}

export function EditDepartmentModal({
  department,
  onClose,
  onSuccess,
}: EditDepartmentModalProps) {
  const [formData, setFormData] = useState({
    name: department.name,
    description: department.description || "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle click outside modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      setError("Department name is required");
      return;
    }

    try {
      setLoading(true);
      setError(null);

      await fetchAdminAPI(`/departments/${department.id}`, {
        method: "PUT",
        body: {
          name: formData.name.trim(),
          description: formData.description.trim(),
        },
      });

      toast.success("Department updated");
      // Await so we don't close the modal before the parent has refetched
      // (otherwise the table briefly flashes the stale row).
      await onSuccess();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to update department";
      setError(msg);
      toast.error("Failed to update department");
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  return (
    <div className="fixed inset-0 bg-foreground dark:bg-background bg-opacity-50 dark:bg-opacity-70 overflow-y-auto h-full w-full z-50">
      <div className="relative top-20 mx-auto p-5 border dark:border-border w-full max-w-lg shadow-lg rounded-md bg-card dark:bg-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-foreground">Edit Department</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-muted-foreground"
          >
            <CloseIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="p-3 bg-destructive/10 border border-destructive/30 text-destructive rounded"
            >
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="dept-name"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Department Name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              id="dept-name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              aria-invalid={error && !formData.name.trim() ? "true" : undefined}
              aria-describedby={
                error && !formData.name.trim() ? "dept-name-error" : undefined
              }
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
            {error && !formData.name.trim() && (
              <p
                id="dept-name-error"
                role="alert"
                className="text-sm text-destructive mt-1"
              >
                {error}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="dept-description"
                className="block text-sm font-medium text-foreground"
              >
                Description
              </label>
              <span
                className={`text-xs ${
                  formData.description.length > 900
                    ? formData.description.length >= 1000
                      ? "text-destructive font-medium"
                      : "text-amber-500"
                    : "text-muted-foreground"
                }`}
              >
                {formData.description.length} / 1000
              </span>
            </div>
            <textarea
              id="dept-description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows={3}
              maxLength={1000}
              className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Updating..." : "Update Department"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 border border-input text-foreground rounded-md hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
