'use client';

// src/app/dashboard/doctors/page.tsx
import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Doctor } from "@/lib/types";
import { DoctorsTable } from "./components/DoctorsTable";
import Link from "next/link";

export default function DoctorsPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDoctors = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetchAdminAPI('/doctors');
      setDoctors(response.doctors || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch doctors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDoctors();
  }, []);

  const handleDoctorDeleted = () => {
    // Refresh the list after deletion
    fetchDoctors();
  };

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
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
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
          <p className="text-gray-500">No doctors found. Add your first doctor to get started.</p>
        </div>
      ) : (
        <DoctorsTable doctors={doctors} onDoctorDeleted={handleDoctorDeleted} />
      )}
    </div>
  );
}