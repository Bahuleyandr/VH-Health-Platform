'use client';

// src/app/dashboard/doctors/page.tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchAdminAPI } from '@/lib/api';
import type { Doctor } from '@/lib/types';
import { DoctorsTable } from './components/DoctorsTable';
import Link from 'next/link';

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export default function DoctorsPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDoctors = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // The API may return an array or an object with { doctors } (or sometimes { data })
      const resp = await fetchAdminAPI<unknown>('/doctors');

      let list: Doctor[] = [];
      if (Array.isArray(resp)) {
        list = resp as Doctor[];
      } else if (isObj(resp)) {
        const r = resp as any;
        if (Array.isArray(r.doctors)) list = r.doctors as Doctor[];
        else if (Array.isArray(r.data)) list = r.data as Doctor[];
      }

      setDoctors(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch doctors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchDoctors();
      } catch {
        // already handled in fetchDoctors
      }
    })();
    return () => {
      cancelled = true; // keeps pattern consistent if you expand later
    };
  }, [fetchDoctors]);

  const handleDoctorDeleted = () => {
    // Refresh the list after deletion
    fetchDoctors();
  };

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
