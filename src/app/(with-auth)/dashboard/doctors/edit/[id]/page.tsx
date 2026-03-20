// src/app/(with-auth)/dashboard/doctors/edit/[id]/page.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import type { Department, Doctor } from "@/lib/types";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { EditDoctorForm } from "./components/EditDoctorForm";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

// Prefer user_id, but fall back to an optional id if present in payloads
function getDoctorKey(d: Doctor): string | number | undefined {
  const userId = (d as unknown as { user_id?: string | number }).user_id;
  if (typeof userId === "string" || typeof userId === "number") return userId;

  const maybeId = (d as unknown as Record<string, unknown>).id;
  if (typeof maybeId === "string" || typeof maybeId === "number")
    return maybeId;

  return undefined;
}

export default function EditDoctorPage() {
  const params = useParams<{ id: string }>();
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
          fetchAdminAPI<unknown>("/doctors"),
          fetchAdminAPI<{ departments?: Department[] } | Department[]>(
            "/admin/departments/manage",
          ),
        ]);

        // ---- normalize doctors ----
        let doctors: Doctor[] = [];
        if (Array.isArray(doctorsResp)) {
          doctors = doctorsResp as Doctor[];
        } else if (isObj(doctorsResp)) {
          const r = doctorsResp as { doctors?: unknown; data?: unknown };
          if (Array.isArray(r.doctors)) doctors = r.doctors as Doctor[];
          else if (Array.isArray(r.data)) doctors = r.data as Doctor[];
        }

        // ---- normalize departments ----
        let depts: Department[] = [];
        if (Array.isArray(departmentsResp)) {
          depts = departmentsResp as Department[];
        } else if (isObj(departmentsResp)) {
          const maybe = (departmentsResp as { departments?: unknown })
            .departments;
          if (Array.isArray(maybe)) depts = maybe as Department[];
        }

        // Find the specific doctor to edit using user_id or fallback id
        const match = doctors.find(
          (d) => String(getDoctorKey(d) ?? "") === doctorId,
        );

        if (!match) {
          if (!cancelled) setError("Doctor not found");
        } else {
          if (!cancelled) setDoctor(match);
        }
        if (!cancelled) setDepartments(depts);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to fetch data");
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
          <Link
            href="/dashboard/doctors"
            className="text-blue-600 hover:text-blue-800"
          >
            ← Back to Doctors
          </Link>
        </div>
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error || "Doctor not found"}
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
      <h1 className="text-3xl font-bold text-gray-900 mb-6">
        Edit Doctor: {doctor.name}
      </h1>
      <EditDoctorForm doctor={doctor} departments={departments} />
    </div>
  );
}
