// src/app/dashboard/admin-management/page.tsx

import { listAdmins } from "@/lib/api";
import { AdminUser } from "@/lib/types";
import { CreateAdminForm } from "./components/CreateAdminForm";
import { AdminsTable } from "./components/AdminsTable";
import { Suspense } from "react";

export default async function AdminManagementPage() {
  // Fetching from the GET /auth/admin/list endpoint
  const response = await listAdmins();
  const admins: AdminUser[] = response.admins || []; 

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Administrator Management</h2>
      
      <CreateAdminForm />

      <h3 className="text-xl font-semibold mt-8 mb-4">Current Administrators</h3>
      <Suspense fallback={<div>Loading admins...</div>}>
        <AdminsTable admins={admins} />
      </Suspense>
    </div>
  );
}