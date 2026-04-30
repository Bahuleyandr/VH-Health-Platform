// src/app/(with-auth)/dashboard/doctors/edit/[id]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchAdminAPI } from "@/lib/api";
import type { Department, Doctor } from "@/lib/types";
import { EditDoctorForm } from "./components/EditDoctorForm";
import Link from "next/link";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

// Prefer doctors.id (the table PK; what the list returns and what the
// edit-link href uses), with user_id as a legacy fallback for doctors
// paired with a user account.
function getDoctorKey(d: Doctor): string | number | undefined {
  const id = (d as unknown as { id?: string | number }).id;
  if (typeof id === "string" || typeof id === "number") return id;

  const userId = (d as unknown as { user_id?: string | number }).user_id;
  if (typeof userId === "string" || typeof userId === "number") return userId;

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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
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
            className="text-primary hover:text-primary"
          >
            ← Back to Doctors
          </Link>
        </div>
        <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
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
          className="text-primary hover:text-primary"
        >
          ← Back to Doctors
        </Link>
      </div>
      <h1 className="text-3xl font-bold text-foreground mb-6">
        Edit Doctor: {doctor.name}
      </h1>
      <EditDoctorForm doctor={doctor} departments={departments} />
    </div>
  );
}
