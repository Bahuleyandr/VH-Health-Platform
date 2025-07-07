// src/app/dashboard/users/page.tsx

import { fetchAdminAPI } from "@/lib/api";
import { UsersAPIResponse } from "@/lib/types";
import { UsersTable } from "./components/UsersTable";
import { PaginationControls } from "./components/PaginationControls";
import { UserFilters } from "./components/UserFilters"; // Import the new component
import { Suspense } from "react";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const queryParams = new URLSearchParams();
  if (searchParams.page) queryParams.set('page', searchParams.page as string);
  if (searchParams.role) queryParams.set('role', searchParams.role as string);
  if (searchParams.search) queryParams.set('search', searchParams.search as string);

  if (!queryParams.has('page')) {
    queryParams.set('page', '1');
  }

  const path = `/admin/users?${queryParams.toString()}`;

  const data: UsersAPIResponse = await fetchAdminAPI(path);
  const { users, pagination } = data;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">User Management</h2>
      
      {/* Add the UserFilters component here */}
      <Suspense fallback={<div>Loading filters...</div>}>
          <UserFilters />
      </Suspense>
      
      <Suspense fallback={<div>Loading table...</div>}>
        <UsersTable users={users} />
      </Suspense>
      
      <PaginationControls pagination={pagination} />
    </div>
  );
}