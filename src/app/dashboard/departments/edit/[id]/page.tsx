// src/app/dashboard/departments/edit/[id]/page.tsx
import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import { EditDepartmentForm } from "./components/EditDepartmentForm";
import { Suspense } from "react";

export default async function EditDepartmentPage({ params }: { params: { id: string } }) {
  // Assuming your backend has an endpoint to get a single department by ID.
  // We are inferring this from the PUT /:id and DELETE /:id routes.
  const department: Department = await fetchAdminAPI(`/departments/${params.id}`);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Edit Department: {department.name}</h2>
      <Suspense fallback={<div>Loading form...</div>}>
        <EditDepartmentForm department={department} />
      </Suspense>
    </div>
  );
}