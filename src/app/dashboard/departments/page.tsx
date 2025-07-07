// src/app/dashboard/departments/page.tsx

import { fetchAdminAPI } from "@/lib/api";
import { Department } from "@/lib/types";
import { CreateDepartmentForm } from "./components/CreateDepartmentForm";
import { DepartmentsTable } from "./components/DepartmentsTable";
import { Suspense } from "react";

export default async function DepartmentsPage() {
  // Fetching from the GET /manage endpoint in adminDepartmentRoutes.js
  const response = await fetchAdminAPI('/departments/manage');
  const departments: Department[] = response.departments; // Assuming the API returns { departments: [...] }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Department Management</h2>
      <CreateDepartmentForm />
      <Suspense fallback={<div>Loading departments...</div>}>
        <DepartmentsTable departments={departments} />
      </Suspense>
    </div>
  );
}