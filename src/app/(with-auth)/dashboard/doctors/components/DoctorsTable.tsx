// src/app/(with-auth)/dashboard/doctors/components/DoctorsTable.tsx
"use client";

import { Doctor } from "@/lib/types";
import Link from "next/link";
import { useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface DoctorsTableProps {
  doctors: Doctor[];
  onDoctorDeleted?: () => void;
}

export function DoctorsTable({ doctors, onDoctorDeleted }: DoctorsTableProps) {
  const [deleting, setDeleting] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDoctor, setPendingDoctor] = useState<Doctor | null>(null);

  const handleDeleteClick = (doctor: Doctor) => {
    setPendingDoctor(doctor);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDoctor) return;

    setDeleting(pendingDoctor.user_id);
    try {
      await fetchAdminAPI(`/doctors/${pendingDoctor.user_id}`, {
        method: "DELETE",
      });

      if (onDoctorDeleted) {
        onDoctorDeleted();
      }
    } catch (error) {
      console.error("Deletion failed:", error);
      alert("Failed to delete doctor. Please try again.");
    } finally {
      setDeleting(null);
      setPendingDoctor(null);
    }
  };

  return (
    <>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Doctor
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Department
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Specialization
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Consultation Fee
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Schedule
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-border">
              {doctors.map((doctor) => (
                <tr key={doctor.user_id} className="hover:bg-muted">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {doctor.name}
                      </div>
                      <div className="text-sm text-muted-foreground">{doctor.email}</div>
                      <div className="text-sm text-muted-foreground">{doctor.phone}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-foreground">
                      {doctor.department}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-foreground">
                      {doctor.specialization}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-foreground">
                      ₹{doctor.consultation_fee}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1">
                      {((doctor as Record<string, unknown>).available_days as string[] | undefined)?.map((day: string) => (
                        <span
                          key={day}
                          className="inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded bg-primary/10 text-primary"
                        >
                          {day.slice(0, 3)}
                        </span>
                      )) ?? (
                        <span className="text-xs text-muted-foreground">Not set</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        doctor.is_available
                          ? "bg-success/10 text-success"
                          : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {doctor.is_available ? "Available" : "Unavailable"}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/dashboard/doctors/edit/${doctor.user_id}`}
                        className="text-primary hover:text-primary transition-colors"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => handleDeleteClick(doctor)}
                        disabled={deleting === doctor.user_id}
                        className={`${
                          deleting === doctor.user_id
                            ? "text-muted-foreground cursor-not-allowed"
                            : "text-destructive hover:text-destructive transition-colors"
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

      <ConfirmDialog
        open={confirmOpen}
        setOpen={setConfirmOpen}
        title="Remove Doctor"
        message={
          pendingDoctor
            ? `This will remove Dr. ${pendingDoctor.name}'s account. Their records will be preserved.`
            : "This will remove the doctor's account. Their records will be preserved."
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}
