// src/app/dashboard/departments/components/CreateDepartmentForm.tsx
"use client";

import { useState } from "react";
import { useCreateDepartment } from "@/hooks/api-hooks";

export function CreateDepartmentForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
  });

  const createDepartment = useCreateDepartment();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      return;
    }

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
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  return (
    <div className="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Create New Department</h2>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="font-medium text-blue-600 hover:text-blue-700"
          type="button"
        >
          {isOpen ? "Cancel" : "+ Add Department"}
        </button>
      </div>

      {isOpen && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="name"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Department Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="e.g., Cardiology, Neurology"
              disabled={createDepartment.isPending}
              required
            />
          </div>

          <div>
            <label
              htmlFor="description"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Description
            </label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows={3}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="Brief description of the department..."
              disabled={createDepartment.isPending}
            />
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={createDepartment.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createDepartment.isPending ? "Creating..." : "Create Department"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setFormData({ name: "", description: "" });
              }}
              disabled={createDepartment.isPending}
              className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
