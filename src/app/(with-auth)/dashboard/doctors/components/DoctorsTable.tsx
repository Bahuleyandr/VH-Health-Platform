// src/app/(with-auth)/dashboard/doctors/components/DoctorsTable.tsx
"use client";

import { AlertDialog } from "@/components/ui/alert-dialog";
import { fetchAdminAPI } from "@/lib/api";
import { Doctor } from "@/lib/types";
import Link from "next/link";
import { useState } from "react";
import toast from "react-hot-toast";

interface DoctorsTableProps {
  doctors: Doctor[];
  onDoctorDeleted?: () => void;
}

export function DoctorsTable({ doctors, onDoctorDeleted }: DoctorsTableProps) {
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleting(deleteTarget.id);
    try {
      await fetchAdminAPI(`/doctors/${deleteTarget.id}`, {
        method: "DELETE",
      });

      onDoctorDeleted?.();
      toast.success(`Dr. ${deleteTarget.name} deleted successfully`);
    } catch {
      toast.error("Failed to delete doctor. Please try again.");
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  };

  return (
    <>
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Doctor
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Department
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Specialization
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Consultation Fee
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Status
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {doctors.map((doctor) => (
              <tr key={doctor.user_id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {doctor.name}
                    </div>
                    <div className="text-sm text-gray-500">{doctor.email}</div>
                    <div className="text-sm text-gray-500">{doctor.phone}</div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">
                    {doctor.department}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">
                    {doctor.specialization}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900">
                    ₹{doctor.consultation_fee}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      doctor.is_available
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {doctor.is_available ? "Available" : "Unavailable"}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/dashboard/doctors/edit/${doctor.user_id}`}
                      className="text-blue-600 hover:text-blue-900 transition-colors"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => setDeleteTarget({ id: doctor.user_id, name: doctor.name })}
                      disabled={deleting === doctor.user_id}
                      className={`${
                        deleting === doctor.user_id
                          ? "text-gray-400 cursor-not-allowed"
                          : "text-red-600 hover:text-red-900 transition-colors"
                      }`}
                    >
                      {deleting === doctor.user_id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    <AlertDialog
      open={!!deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      title="Delete doctor"
      description={`Are you sure you want to delete Dr. ${deleteTarget?.name ?? ""}'s account? This action cannot be undone.`}
      confirmLabel="Delete"
      variant="destructive"
      onConfirm={handleDelete}
      loading={deleting !== null}
    />
    </>
  );
}
