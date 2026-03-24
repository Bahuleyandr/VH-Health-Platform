// src/app/(with-auth)/dashboard/doctors/page.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { normalizeList } from "@/lib/normalize-response";
import type { Doctor } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { DoctorsTable } from "./components/DoctorsTable";

const normalizeDoctors = normalizeList<Doctor>("doctors");

export default function DoctorsPage() {
  const queryClient = useQueryClient();

  const {
    data: doctors = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["doctors"],
    queryFn: async () => {
      const resp = await fetchAdminAPI<unknown>("/doctors");
      return normalizeDoctors(resp);
    },
  });

  const handleDoctorDeleted = () => {
    queryClient.invalidateQueries({ queryKey: ["doctors"] });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error instanceof Error ? error.message : "Failed to fetch doctors"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Doctor Management</h1>
        <Link
          href="/dashboard/doctors/create"
          className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors"
        >
          Add New Doctor
        </Link>
      </div>

      {doctors.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-500">
            No doctors found. Add your first doctor to get started.
          </p>
        </div>
      ) : (
        <DoctorsTable doctors={doctors} onDoctorDeleted={handleDoctorDeleted} />
      )}
    </div>
  );
}
