// src/app/dashboard/departments/components/DepartmentsTable.tsx
'use client'; // <-- This is added to make it a Client Component

import { Department } from "@/lib/types";
import Link from "next/link";
import { deleteDepartment } from "../actions"; // Import the delete action

export function DepartmentsTable({ departments }: { departments: Department[] }) {
  
  /**
   * Handles the form submission for deleting a department.
   * It shows a confirmation dialog to the user before proceeding.
   * @param {React.MouseEvent<HTMLFormElement>} event - The form submission event.
   */
  const handleDelete = (event: React.FormEvent<HTMLFormElement>) => {
    if (!window.confirm("Are you sure you want to delete this department? This action cannot be undone.")) {
      // If the user clicks "Cancel", we prevent the form from submitting.
      event.preventDefault();
    }
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {departments.map((dept) => (
            <tr key={dept.id}>
              <td className="px-6 py-4 whitespace-nowrap font-medium text-gray-900">{dept.name}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{dept.description}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium flex items-center gap-4">
                {/* Edit Link */}
                <Link href={`/dashboard/departments/edit/${dept.id}`} className="text-indigo-600 hover:text-indigo-900">
                  Edit
                </Link>
                
                {/* Delete Form */}
                <form action={deleteDepartment} onSubmit={handleDelete}>
                  <input type="hidden" name="id" value={dept.id} />
                  <button type="submit" className="text-red-600 hover:text-red-900">
                    Delete
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
