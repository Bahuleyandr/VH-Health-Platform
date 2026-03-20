// src/app/(with-auth)/dashboard/doctors/page.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import type { Doctor } from "@/lib/types";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DoctorsTable } from "./components/DoctorsTable";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isDoctor(x: unknown): x is Doctor {
  if (!isObj(x)) return false;
  // Minimal shape check; add fields if your type requires more
  const id = (x as Record<string, unknown>).id;
  const name = (x as Record<string, unknown>).name;
  return (
    (typeof id === "number" || typeof id === "string") &&
    typeof name === "string"
  );
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
      const resp = await fetchAdminAPI<unknown>("/doctors");

      let list: Doctor[] = [];

      if (Array.isArray(resp)) {
        list = (resp as unknown[]).filter(isDoctor);
      } else if (isObj(resp)) {
        const obj = resp as Record<string, unknown>;
        const doctorsProp = obj["doctors"];
        const dataProp = obj["data"];

        if (Array.isArray(doctorsProp)) {
          list = (doctorsProp as unknown[]).filter(isDoctor);
        } else if (Array.isArray(dataProp)) {
          list = (dataProp as unknown[]).filter(isDoctor);
        }
      }

      setDoctors(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch doctors");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Simple effect; no unused "cancelled" flag
    fetchDoctors();
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
