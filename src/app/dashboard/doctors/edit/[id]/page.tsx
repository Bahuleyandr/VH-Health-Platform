'use client';

// src/app/dashboard/doctors/edit/[id]/page.tsx
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { fetchAdminAPI } from '@/lib/api';
import type { Department, Doctor } from '@/lib/types';
import { EditDoctorForm } from './components/EditDoctorForm';
import Link from 'next/link';

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export default function EditDoctorPage() {
  const params = useParams();
  const doctorId = String(params.id);

  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch both doctors and departments in parallel
        const [doctorsResp, departmentsResp] = await Promise.all([
          fetchAdminAPI<unknown>('/doctors'),
          fetchAdminAPI<{ departments?: Department[] } | Department[]>('/departments/manage'),
        ]);

        // ---- normalize doctors ----
        let doctors: Doctor[] = [];
        if (Array.isArray(doctorsResp)) {
          doctors = doctorsResp as Doctor[];
        } else if (isObj(doctorsResp)) {
          const r = doctorsResp as any;
          if (Array.isArray(r.doctors)) doctors = r.doctors as Doctor[];
          else if (Array.isArray(r.data)) doctors = r.data as Doctor[];
        }

        // ---- normalize departments ----
        const depts: Department[] = Array.isArray(departmentsResp)
          ? (departmentsResp as Department[])
          : (departmentsResp.departments ?? []);

        // Find the specific doctor to edit (match by user_id OR id)
        const match = doctors.find((d: any) => {
          const a = String(d?.user_id ?? d?.id ?? '');
          return a === doctorId;
        });

        if (!match) {
          if (!cancelled) setError('Doctor not found');
        } else {
          if (!cancelled) setDoctor(match as Doctor);
        }
        if (!cancelled) setDepartments(depts);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to fetch data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [doctorId]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
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
