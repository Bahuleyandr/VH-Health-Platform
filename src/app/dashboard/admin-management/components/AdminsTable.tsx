// src/app/dashboard/admin-management/components/AdminsTable.tsx
'use client'; // <-- Make this a Client Component

import { AdminUser } from "@/lib/types";
import Link from "next/link";
import { toggleAdminStatusAction } from "../actions";

export function AdminsTable({ admins }: { admins: AdminUser[] }) {

  const handleToggleStatus = (event: React.FormEvent<HTMLFormElement>) => {
    if (!window.confirm("Are you sure you want to change this admin's status?")) {
      event.preventDefault();
    }
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Admin</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role & Status</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {admins.map((admin) => (
            <tr key={admin.id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">{admin.name}</div>
                <div className="text-sm text-gray-500">{admin.email}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                 <div className="text-sm text-gray-900">{admin.role}</div>
                 <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${admin.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {admin.is_active ? 'Active' : 'Inactive'}
                 </span>
              </td>
               <td className="px-6 py-4 whitespace-nowrap text-sm font-medium flex items-center gap-4">
                <Link href={`/dashboard/admin-management/edit-permissions/${admin.id}`} className="text-indigo-600 hover:text-indigo-900">
                    Edit Permissions
                </Link>
                <form action={toggleAdminStatusAction} onSubmit={handleToggleStatus}>
                    <input type="hidden" name="id" value={admin.id} />
                    <input type="hidden" name="is_active" value={String(admin.is_active)} />
                    <button type="submit" className={admin.is_active ? 'text-red-600 hover:text-red-900' : 'text-green-600 hover:text-green-900'}>
                        {admin.is_active ? 'Deactivate' : 'Reactivate'}
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