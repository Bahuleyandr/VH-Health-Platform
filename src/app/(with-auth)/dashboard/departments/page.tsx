// src/app/(with-auth)/dashboard/departments/page.tsx
"use client";

import { useState } from "react";
import { useDepartments } from "@/hooks/api-hooks";
import { CreateDepartmentForm } from "./components/CreateDepartmentForm";
import { DepartmentsTable } from "./components/DepartmentsTable";
import { Skeleton } from "@/components/ui/skeleton";
import toast from "react-hot-toast";
import type { Department } from "@/lib/types";

function DepartmentsSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64 mb-2" />
        <Skeleton className="h-4 w-80" />
      </div>
      {/* Search bar skeleton */}
      <div className="bg-white dark:bg-card p-4 rounded-lg shadow">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      {/* Create form skeleton */}
      <div className="border rounded-lg p-4 space-y-3">
        <Skeleton className="h-5 w-48" />
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      {/* Table skeleton */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-muted/50 px-4 py-3 flex gap-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20 ml-auto" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-4 items-center px-4 py-3 border-t">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-24" />
            <div className="flex gap-2 ml-auto">
              <Skeleton className="h-7 w-14 rounded" />
              <Skeleton className="h-7 w-14 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isDepartment(v: unknown): v is Department {
  if (!isRecord(v)) return false;
  const name = v.name as unknown;
  return typeof name === "string";
}
function isDepartmentArray(v: unknown): v is Department[] {
  return Array.isArray(v) && v.every(isDepartment);
}

export default function DepartmentsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const { data, isLoading, error, refetch } = useDepartments();

  // Normalize whatever the hook returns into Department[]
  let departments: Department[] = [];
  if (Array.isArray(data)) {
    departments = data.filter(isDepartment);
  } else if (
    isRecord(data) &&
    isDepartmentArray((data as Record<string, unknown>).departments)
  ) {
    departments = (data as Record<string, unknown>).departments as Department[];
  }

  // Filter departments based on search term
  const term = searchTerm.toLowerCase();
  const filteredDepartments = departments.filter(
    (dept) =>
      dept.name.toLowerCase().includes(term) ||
      (dept.description?.toLowerCase().includes(term) ?? false),
  );

  if (isLoading) {
    return <DepartmentsSkeleton />;
  }

  if (error) {
    return (
      <div className="bg-destructive/10 dark:bg-destructive/20 border border-destructive/30 dark:border-destructive/30 text-destructive dark:text-destructive/60 rounded-lg p-4">
        <h3 className="font-semibold mb-1">Error Loading Departments</h3>
        <p>
          {error instanceof Error
            ? error.message
            : "Failed to load departments"}
        </p>
        <button
          onClick={() => {
            toast.promise(refetch(), {
              loading: "Refreshing departments...",
              success: "Departments refreshed!",
              error: "Failed to refresh departments",
            });
          }}
          className="mt-2 px-4 py-2 bg-destructive text-white rounded hover:bg-destructive/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Department Management</h1>
        <p className="text-muted-foreground dark:text-muted-foreground mt-2">
          Manage hospital departments and their information
        </p>
      </div>

      {/* Search Bar */}
      <div className="bg-white dark:bg-card p-4 rounded-lg shadow">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search departments by name or description..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-4 py-2 border border-input dark:border-input rounded-md focus:outline-none focus:ring-2 focus:ring-primary bg-white dark:bg-muted text-foreground dark:text-white"
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {filteredDepartments.length} of {departments.length} departments
          </div>
        </div>
      </div>

      {/* Create Department Form */}
      <CreateDepartmentForm />

      {/* Departments Table */}
      <DepartmentsTable
        departments={filteredDepartments}
        onDepartmentUpdated={refetch}
        onDepartmentDeleted={refetch}
      />
    </div>
  );
}
