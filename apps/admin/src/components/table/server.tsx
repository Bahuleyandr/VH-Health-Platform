// src/components/table/server.tsx
"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

export type ServerPagination = {
  page?: number;
  currentPage?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
};

function useTableQueryUpdater() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (patch: Record<string, string | number | null | undefined>) => {
    const next = new URLSearchParams(searchParams.toString());
    Object.entries(patch).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        next.delete(key);
      } else {
        next.set(key, String(value));
      }
    });
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };
}

export function ServerTablePagination({
  pagination,
  itemLabel = "rows",
  pageSizeOptions = [10, 50, 100],
}: {
  pagination?: ServerPagination | null;
  itemLabel?: string;
  pageSizeOptions?: number[];
}) {
  const updateQuery = useTableQueryUpdater();
  const page = Math.max(
    1,
    Number(pagination?.page ?? pagination?.currentPage ?? 1),
  );
  const limit = Math.max(
    1,
    Number(pagination?.limit ?? pageSizeOptions[0] ?? 10),
  );
  const total = Math.max(0, Number(pagination?.total ?? 0));
  const totalPages = Math.max(
    1,
    Number(pagination?.totalPages ?? Math.ceil(total / limit)),
  );
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);

  const Button = ({
    label,
    disabled,
    onClick,
    children,
  }: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-input p-2 text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg bg-card p-3 text-sm shadow dark:bg-card sm:flex-row sm:items-center sm:justify-between">
      <div className="text-muted-foreground">
        Showing {start}-{end} of {total} {itemLabel}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-muted-foreground">
          Rows
          <select
            value={String(limit)}
            onChange={(event) =>
              updateQuery({ limit: Number(event.target.value), page: 1 })
            }
            className="rounded border border-input bg-background px-2 py-1 text-foreground"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <span className="px-2 text-muted-foreground">
          Page {page} of {totalPages}
        </span>

        <Button
          label="First page"
          disabled={page <= 1}
          onClick={() => updateQuery({ page: 1 })}
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          label="Previous page"
          disabled={page <= 1}
          onClick={() => updateQuery({ page: page - 1 })}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          label="Next page"
          disabled={page >= totalPages}
          onClick={() => updateQuery({ page: page + 1 })}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          label="Last page"
          disabled={page >= totalPages}
          onClick={() => updateQuery({ page: totalPages })}
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
