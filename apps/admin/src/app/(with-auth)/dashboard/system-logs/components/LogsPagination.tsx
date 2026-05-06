// src/app/(with-auth)/dashboard/system-logs/components/LogsPagination.tsx
// Previous / page numbers / Next pagination control with page-size selection.

"use client";

interface Props {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export function LogsPagination({
  currentPage,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: Props) {
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-lg bg-white p-3 shadow sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground">
        Showing page {currentPage} of {Math.max(1, totalPages)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Rows
          <select
            value={String(pageSize)}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="rounded border border-input bg-background px-2 py-1 text-foreground"
          >
            <option value="10">10</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>

        <button
          type="button"
          aria-label="Previous page"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            currentPage === 1
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-primary text-white hover:bg-primary/90"
          }`}
        >
          Previous
        </button>

        {totalPages > 1 && (
          <div className="flex gap-1">
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 5) pageNum = i + 1;
              else if (currentPage <= 3) pageNum = i + 1;
              else if (currentPage >= totalPages - 2)
                pageNum = totalPages - 4 + i;
              else pageNum = currentPage - 2 + i;

              return (
                <button
                  type="button"
                  key={pageNum}
                  onClick={() => onPageChange(pageNum)}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    currentPage === pageNum
                      ? "bg-primary text-white"
                      : "bg-muted text-foreground hover:bg-muted"
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          aria-label="Next page"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className={`px-4 py-2 rounded-md font-medium transition-colors ${
            currentPage === totalPages
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-primary text-white hover:bg-primary/90"
          }`}
        >
          Next
        </button>
      </div>
    </div>
  );
}
