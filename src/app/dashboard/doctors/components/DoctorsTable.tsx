// src/app/dashboard/doctors/components/DoctorsTable.tsx
'use client'; // <-- Make this a Client Component

import { Doctor } from "@/lib/types";
import Link from "next/link";
import { deleteDoctorAction } from "../actions";

export function DoctorsTable({ doctors }: { doctors: Doctor[] }) {
  
  const handleDelete = (event: React.FormEvent<HTMLFormElement>) => {
    if (!window.confirm("Are you sure you want to delete this doctor's account?")) {
      event.preventDefault();
    }
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Doctor</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Specialization</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Availability</th>
            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {doctors.map((doctor) => (
            <tr key={doctor.user_id}>
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="text-sm font-medium text-gray-900">{doctor.name}</div>
                <div className="text-sm text-gray-500">{doctor.department}</div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{doctor.specialization}</td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${doctor.is_available ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  {doctor.is_available ? 'Available' : 'Unavailable'}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium flex items-center gap-4">
                <Link href={`/dashboard/doctors/edit/${doctor.user_id}`} className="text-indigo-600 hover:text-indigo-900">
                  Edit
                </Link>
                <form action={deleteDoctorAction} onSubmit={handleDelete}>
                  <input type="hidden" name="id" value={doctor.user_id} />
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