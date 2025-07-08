'use client';

// src/app/dashboard/doctors/create/page.tsx
import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import { CreateDoctorForm } from "../components/CreateDoctorForm";
import Link from "next/link";

export default function CreateDoctorPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDepartments = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetchAdminAPI('/departments/manage');
        setDepartments(response.departments || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch departments');
      } finally {
        setLoading(false);
      }
    };

    fetchDepartments();
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link href="/dashboard/doctors" className="text-blue-600 hover:text-blue-800">
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
        <Link href="/dashboard/doctors" className="text-blue-600 hover:text-blue-800">
          ← Back to Doctors
        </Link>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Add New Doctor</h1>
      <CreateDoctorForm departments={departments} />
    </div>
  );
}