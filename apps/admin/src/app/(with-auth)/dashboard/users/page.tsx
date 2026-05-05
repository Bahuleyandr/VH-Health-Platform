"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { UsersAPIResponse } from "@/lib/types";
import { UsersTable } from "./components/UsersTable";
import { PaginationControls } from "./components/PaginationControls";
import { UserFilters } from "./components/UserFilters";
import { Skeleton } from "@/components/ui/skeleton";

function UsersTableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex gap-4 mb-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-muted/50 px-4 py-3 flex gap-4">
          <Skeleton className="h-4 w-6" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20 ml-auto" />
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex gap-4 items-center px-4 py-3 border-t">
            <Skeleton className="h-4 w-6" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20 ml-auto" />
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center mt-4">
        <Skeleton className="h-4 w-36" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-8 w-8 rounded" />
          <Skeleton className="h-8 w-8 rounded" />
        </div>
      </div>
    </div>
  );
}

function UsersContent() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Build query string from search params
  const queryParams = new URLSearchParams();
  const page = searchParams.get("page") || "1";
  const limit = searchParams.get("limit") || "10";
  const role = searchParams.get("role");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "registered_at";
  const sortOrder = searchParams.get("sortOrder") || "DESC";

  queryParams.set("page", page);
  queryParams.set("limit", limit);
  queryParams.set("sortBy", sortBy);
  queryParams.set("sortOrder", sortOrder);
  if (role) queryParams.set("role", role);
  if (search && search.trim().length >= 2)
    queryParams.set("search", search.trim());

  const { data, isLoading, error } = useQuery<UsersAPIResponse>({
    queryKey: ["users", page, limit, role, search, sortBy, sortOrder],
    queryFn: () => fetchAdminAPI(`/admin/users?${queryParams.toString()}`),
    staleTime: 30_000,
  });

  const onUserUpdated = () => {
    // Invalidate all variations of the 'users' query key
    queryClient.invalidateQueries({ queryKey: ["users"] });
  };

  if (isLoading) {
    return <UsersTableSkeleton />;
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
      <UsersTable
        users={data.users}
        onUserUpdated={onUserUpdated}
        sortBy={sortBy}
        sortOrder={sortOrder}
      />
      <PaginationControls pagination={data.pagination} />
    </>
  );
}

export default function UsersPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">User Management</h2>
      <Suspense fallback={<UsersTableSkeleton />}>
        <UsersContent />
      </Suspense>
    </div>
  );
}
