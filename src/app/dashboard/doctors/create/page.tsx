// src/app/dashboard/doctors/create/page.tsx

import { getDepartments } from "@/lib/api";
import { Department } from "@/lib/types";
import { CreateDoctorForm } from "../components/CreateDoctorForm";
import { Suspense } from "react";

export default async function CreateDoctorPage() {
  // Fetch departments to populate the dropdown in the form
  const response = await getDepartments();
  const departments: Department[] = response.departments || [];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Add a New Doctor</h2>
      <p className="mb-6 text-gray-600">
        Fill out the details below to create a new user account and doctor profile.
      </p>
      <Suspense fallback={<div>Loading form...</div>}>
        <CreateDoctorForm departments={departments} />
      </Suspense>
    </div>
  );
}