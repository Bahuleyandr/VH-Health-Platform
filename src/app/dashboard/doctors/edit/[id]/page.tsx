'use client';

// src/app/dashboard/doctors/edit/[id]/page.tsx
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import { Department, Doctor } from "@/lib/types";
import { EditDoctorForm } from "./components/EditDoctorForm";
import Link from "next/link";

export default function EditDoctorPage() {
  const params = useParams();
  const doctorId = params.id as string;
  
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Fetch both doctors and departments in parallel
        const [doctorsResponse, departmentsResponse] = await Promise.all([
          fetchAdminAPI('/doctors'),
          fetchAdminAPI('/departments/manage'),
        ]);

        const doctors: Doctor[] = doctorsResponse.doctors || [];
        const departments: Department[] = departmentsResponse.departments || departmentsResponse || [];

        // Find the specific doctor to edit
        const doctorToEdit = doctors.find(d => d.user_id.toString() === doctorId);
        
        if (!doctorToEdit) {
          setError('Doctor not found');
        } else {
          setDoctor(doctorToEdit);
        }
        
        setDepartments(departments);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [doctorId]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  if (error || !doctor) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <Link href="/dashboard/doctors" className="text-blue-600 hover:text-blue-800">
            ← Back to Doctors
          </Link>
        </div>
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error || 'Doctor not found'}
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
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Edit Doctor: {doctor.name}</h1>
      <EditDoctorForm doctor={doctor} departments={departments} />
    </div>
  );
}