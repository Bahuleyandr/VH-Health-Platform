// src/app/(with-auth)/dashboard/system-logs/components/LogsPagination.tsx
// Previous / page numbers / Next pagination control. Renders nothing
// when there's only one page.

"use client";

interface Props {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function LogsPagination({
  currentPage,
  totalPages,
  onPageChange,
}: Props) {
  if (totalPages <= 1) return null;

  return (
    <div className="mt-6 flex items-center justify-between">
      <div className="text-sm text-foreground">
        Showing page {currentPage} of {totalPages}
      </div>
      <div className="flex gap-2">
        <button
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

        <div className="flex gap-1">
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            let pageNum;
            if (totalPages <= 5) pageNum = i + 1;
            else if (currentPage <= 3) pageNum = i + 1;
            else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
            else pageNum = currentPage - 2 + i;

            return (
              <button
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

        <button
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
