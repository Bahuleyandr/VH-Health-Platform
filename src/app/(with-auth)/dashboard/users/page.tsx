"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { UsersAPIResponse } from "@/lib/types";
import { UsersTable } from "./components/UsersTable";
import { PaginationControls } from "./components/PaginationControls";
import { UserFilters } from "./components/UserFilters";

function UsersContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Build query string from search params
  const queryParams = new URLSearchParams();
  const page = searchParams.get("page") || "1";
  const role = searchParams.get("role");
  const search = searchParams.get("search");

  queryParams.set("page", page);
  if (role) queryParams.set("role", role);
  if (search) queryParams.set("search", search);

  const { data, isLoading, error } = useQuery<UsersAPIResponse>({
    queryKey: ["users", page, role, search],
    queryFn: () => fetchAdminAPI(`/admin/users?${queryParams.toString()}`),
    staleTime: 30_000,
  });

  const onUserUpdated = () => {
    // Invalidate all variations of the 'users' query key
    queryClient.invalidateQueries({ queryKey: ["users"] });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
        Error:{" "}
        {error instanceof Error ? error.message : "Failed to fetch users"}
      </div>
    );
  }

  if (!data) {
    return <div>No data available</div>;
  }

  return (
    <>
      <UserFilters />
      <UsersTable users={data.users} onUserUpdated={onUserUpdated} />
      <PaginationControls pagination={data.pagination} />
    </>
  );
}

export default function UsersPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">User Management</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <UsersContent />
      </Suspense>
    </div>
  );
}
