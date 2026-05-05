// src/app/(with-auth)/dashboard/users/components/PaginationControls.tsx
"use client";

import type { Pagination } from "@/lib/types";
import { ServerTablePagination } from "@/components/table/server";

export function PaginationControls({
  pagination,
  itemLabel = "users",
}: {
  pagination: Pagination;
  itemLabel?: string;
}) {
  return (
    <ServerTablePagination pagination={pagination} itemLabel={itemLabel} />
  );
}
