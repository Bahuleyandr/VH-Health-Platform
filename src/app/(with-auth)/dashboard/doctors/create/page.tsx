"use client";

// src/app/(with-auth)/dashboard/doctors/create/page.tsx
import { fetchAdminAPI } from "@/lib/api";
import type { Department } from "@/lib/types";
import Link from "next/link";
import { useEffect, useState } from "react";

import { CreateDoctorForm } from "../components/CreateDoctorForm";

export default function CreateDoctorPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchDepartments = async () => {
      try {
        setLoading(true);
        setError(null);

        // The API may return either an array or an object with { departments }
        const resp = await fetchAdminAPI<
          { departments?: Department[] } | Department[]
        >("/admin/departments/manage");

        const list: Department[] = Array.isArray(resp)
          ? resp
          : (resp.departments ?? []);

        if (!cancelled) setDepartments(list);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to fetch departments",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDepartments();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
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
        <div className="mb-4">
          <Link
            href="/dashboard/doctors"
            className="text-blue-600 hover:text-blue-800"
          >
            ← Back to Doctors
          </Link>
        </div>
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link
          href="/dashboard/doctors"
          className="text-blue-600 hover:text-blue-800"
        >
          ← Back to Doctors
        </Link>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Add New Doctor</h1>
      <CreateDoctorForm departments={departments} />
    </div>
  );
}
