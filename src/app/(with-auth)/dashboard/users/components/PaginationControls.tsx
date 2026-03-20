// src/app/(with-auth)/dashboard/users/components/PaginationControls.tsx
"use client";

import { Pagination } from "@/lib/types";
import { useRouter, useSearchParams } from "next/navigation";

export function PaginationControls({ pagination }: { pagination: Pagination }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handlePrev = () => {
    const params = new URLSearchParams(searchParams);
    params.set("page", (pagination.page - 1).toString());
    router.push(`/dashboard/users?${params.toString()}`);
  };

  const handleNext = () => {
    const params = new URLSearchParams(searchParams);
    params.set("page", (pagination.page + 1).toString());
    router.push(`/dashboard/users?${params.toString()}`);
  };

  return (
    <div className="flex items-center justify-between mt-4">
      <button onClick={handlePrev} disabled={!pagination.hasPrev}>
        Previous
      </button>
      <span>
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <button onClick={handleNext} disabled={!pagination.hasNext}>
        Next
      </button>
    </div>
  );
}
