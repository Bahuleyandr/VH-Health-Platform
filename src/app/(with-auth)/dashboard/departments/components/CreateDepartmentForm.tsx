// src/app/(with-auth)/dashboard/departments/components/CreateDepartmentForm.tsx
"use client";

import { useState } from "react";
import { useCreateDepartment } from "@/hooks/api-hooks";

export function CreateDepartmentForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [nameError, setNameError] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    description: "",
  });

  const createDepartment = useCreateDepartment();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      setNameError("Department name is required.");
      return;
    }

    setNameError("");

    try {
      await createDepartment.mutateAsync({
        name: formData.name.trim(),
        description: formData.description.trim(),
      });

      // Reset form and close
      setFormData({ name: "", description: "" });
      setIsOpen(false);
    } catch {
      // Errors are surfaced by the mutation hook (toast, etc.)
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    if (name === "name" && nameError) {
      setNameError("");
    }
  };

  return (
    <div className="rounded-lg bg-white p-6 shadow dark:bg-card">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Create New Department</h2>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="font-medium text-primary hover:text-primary"
          type="button"
        >
          {isOpen ? "Cancel" : "+ Add Department"}
        </button>
      </div>

      {isOpen && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="dept-create-name"
              className="mb-1 block text-sm font-medium text-foreground dark:text-foreground"
            >
              Department Name <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              id="dept-create-name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              aria-invalid={nameError ? "true" : undefined}
              aria-describedby={nameError ? "dept-create-name-error" : undefined}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary dark:border-input dark:bg-muted dark:text-white"
              placeholder="e.g., Cardiology, Neurology"
              disabled={createDepartment.isPending}
              required
            />
            {nameError && (
              <p
                id="dept-create-name-error"
                role="alert"
                className="text-sm text-destructive mt-1"
              >
                {nameError}
              </p>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label
                htmlFor="dept-create-description"
                className="block text-sm font-medium text-foreground dark:text-foreground"
              >
                Description
              </label>
              <span className={`text-xs ${
                formData.description.length > 900
                  ? formData.description.length >= 1000
                    ? "text-destructive font-medium"
                    : "text-amber-500"
                  : "text-muted-foreground"
              }`}>
                {formData.description.length} / 1000
              </span>
            </div>
            <textarea
              id="dept-create-description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows={3}
              maxLength={1000}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary dark:border-input dark:bg-muted dark:text-white"
              placeholder="Brief description of the department..."
              disabled={createDepartment.isPending}
            />
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={createDepartment.isPending}
              className="rounded-md bg-primary px-4 py-2 text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createDepartment.isPending ? "Creating..." : "Create Department"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setFormData({ name: "", description: "" });
                setNameError("");
              }}
              disabled={createDepartment.isPending}
              className="rounded-md border border-input px-4 py-2 text-foreground hover:bg-muted disabled:opacity-50 dark:border-input dark:text-foreground dark:hover:bg-muted/50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
