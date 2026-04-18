// src/components/PaginationControls.tsx
"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Pagination } from "@/lib/types";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";

export function PaginationControls({ pagination }: { pagination: Pagination }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handlePrev = () => {
    const params = new URLSearchParams(searchParams);
    params.set("page", (pagination.page - 1).toString());
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleNext = () => {
    const params = new URLSearchParams(searchParams);
    params.set("page", (pagination.page + 1).toString());
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex items-center justify-between mt-4 bg-white px-4 py-3 sm:px-6 rounded-lg shadow">
      <div className="flex flex-1 justify-between sm:hidden">
        <button
          onClick={handlePrev}
          disabled={!pagination.hasPrev}
          aria-disabled={!pagination.hasPrev}
          className={`relative inline-flex items-center px-4 py-2 text-sm font-medium rounded-md ${
            pagination.hasPrev
              ? "bg-white text-foreground hover:bg-muted"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          Previous
        </button>
        <button
          onClick={handleNext}
          disabled={!pagination.hasNext}
          aria-disabled={!pagination.hasNext}
          className={`relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium rounded-md ${
            pagination.hasNext
              ? "bg-white text-foreground hover:bg-muted"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          Next
        </button>
      </div>
      <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-foreground">
            Showing page <span className="font-medium">{pagination.page}</span>{" "}
            of <span className="font-medium">{pagination.totalPages}</span> (
            <span className="font-medium">{pagination.total}</span> total
            results)
          </p>
        </div>
        <div>
          <nav
            className="isolate inline-flex -space-x-px rounded-md shadow-sm"
            aria-label="Pagination"
          >
            <button
              onClick={handlePrev}
              disabled={!pagination.hasPrev}
              aria-disabled={!pagination.hasPrev}
              className={`relative inline-flex items-center rounded-l-md px-2 py-2 text-muted-foreground ring-1 ring-inset ring-border ${
                pagination.hasPrev ? "hover:bg-muted" : "cursor-not-allowed"
              }`}
            >
              <span className="sr-only">Previous</span>
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <span className="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-foreground ring-1 ring-inset ring-border">
              {pagination.page}
            </span>
            <button
              onClick={handleNext}
              disabled={!pagination.hasNext}
              aria-disabled={!pagination.hasNext}
              className={`relative inline-flex items-center rounded-r-md px-2 py-2 text-muted-foreground ring-1 ring-inset ring-border ${
                pagination.hasNext ? "hover:bg-muted" : "cursor-not-allowed"
              }`}
            >
              <span className="sr-only">Next</span>
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          </nav>
        </div>
      </div>
    </div>
  );
}
