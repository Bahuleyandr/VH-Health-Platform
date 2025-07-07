// src/app/dashboard/doctors/edit/[id]/page.tsx

import { getDepartments, getDoctors } from "@/lib/api";
import { Department, Doctor } from "@/lib/types";
import { EditDoctorForm } from "./components/EditDoctorForm";
import { Suspense } from "react";

export default async function EditDoctorPage({ params }: { params: { id: string } }) {
  // Fetch all doctors and departments
  const [doctorsResponse, departmentsResponse] = await Promise.all([
    getDoctors(),
    getDepartments(),
  ]);

  const doctors: Doctor[] = doctorsResponse.doctors || [];
  const departments: Department[] = departmentsResponse.departments || [];

  // Find the specific doctor to edit
  const doctorToEdit = doctors.find(d => d.user_id.toString() === params.id);

  if (!doctorToEdit) {
    return <div>Doctor not found.</div>;
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Edit Doctor: {doctorToEdit.name}</h2>
      <Suspense fallback={<div>Loading form...</div>}>
        <EditDoctorForm doctor={doctorToEdit} departments={departments} />
      </Suspense>
    </div>
  );
}