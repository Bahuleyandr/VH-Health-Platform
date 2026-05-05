// src/app/(with-auth)/dashboard/doctors/page.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { normalizeList } from "@/lib/normalize-response";
import type { Doctor } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { DoctorsTable } from "./components/DoctorsTable";
import { Skeleton } from "@/components/ui/skeleton";

function DoctorsTableSkeleton() {
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-muted/50 px-4 py-3 flex gap-4">
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20 ml-auto" />
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex gap-4 items-center px-4 py-3 border-t">
            <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

const normalizeDoctors = normalizeList<Doctor>("doctors");
const DOCTOR_TABLE_FETCH_LIMIT = 1000;

export default function DoctorsPage() {
  const queryClient = useQueryClient();

  const {
    data: doctors = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["doctors"],
    queryFn: async () => {
      const resp = await fetchAdminAPI<unknown>(
        `/doctors?limit=${DOCTOR_TABLE_FETCH_LIMIT}`,
      );
      return normalizeDoctors(resp);
    },
  });

  const handleDoctorDeleted = () => {
    queryClient.invalidateQueries({ queryKey: ["doctors"] });
  };

  if (isLoading) {
    return <DoctorsTableSkeleton />;
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
          Error:{" "}
          {error instanceof Error ? error.message : "Failed to fetch doctors"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-foreground">
          Doctor Management
        </h1>
        <Link
          href="/dashboard/doctors/create"
          className="bg-primary text-white px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
        >
          Add New Doctor
        </Link>
      </div>

      {doctors.length === 0 ? (
        <div className="bg-muted border border-border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">
            No doctors found. Add your first doctor to get started.
          </p>
        </div>
      ) : (
        <DoctorsTable doctors={doctors} onDoctorDeleted={handleDoctorDeleted} />
      )}
    </div>
  );
}
