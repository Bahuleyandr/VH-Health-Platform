"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  listCathConsumablesUnbilledUsage,
  type CathConsumableUnbilledUsageItem,
} from "@/lib/api/cathConsumables";

interface DateFilter {
  date_from: string;
  date_to: string;
}

const PAGE_SIZE = 50;

function dateInput(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function UnbilledUsageTab() {
  const [filter, setFilter] = useState<DateFilter>(() => ({
    date_from: dateInput(29),
    date_to: dateInput(0),
  }));
  const [appliedFilter, setAppliedFilter] = useState<DateFilter>(() => ({
    date_from: dateInput(29),
    date_to: dateInput(0),
  }));
  const [page, setPage] = useState(1);

  const reportQuery = useQuery({
    queryKey: ["cath-consumables", "unbilled-usage", appliedFilter, page],
    queryFn: () =>
      listCathConsumablesUnbilledUsage({
        date_from: appliedFilter.date_from || undefined,
        date_to: appliedFilter.date_to || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  });

  const items = reportQuery.data?.items ?? [];
  const total = reportQuery.data?.total ?? 0;
  const currentPage = reportQuery.data?.page ?? page;
  const totalPages = total === 0
    ? 0
    : Math.ceil(total / (reportQuery.data?.limit ?? PAGE_SIZE));
  const pageLimit = reportQuery.data?.limit ?? PAGE_SIZE;
  const firstRow = total === 0 ? 0 : (currentPage - 1) * pageLimit + 1;
  const lastRow = Math.min(currentPage * pageLimit, total);

  return (
    <section aria-labelledby="unbilled-usage-heading" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2
              id="unbilled-usage-heading"
              className="text-xl font-semibold text-foreground"
            >
              Unbilled cath usage
            </h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {total}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every documented usage row that could not produce a billing event
            remains visible here for finance follow-up.
          </p>
        </div>
        <button
          className="h-10 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
          onClick={() => void reportQuery.refetch()}
          type="button"
        >
          Refresh
        </button>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setAppliedFilter({ ...filter });
        }}
      >
        <label className="text-xs font-medium text-muted-foreground">
          From
          <input
            aria-label="Unbilled usage from date"
            className="mt-1 block h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                date_from: event.target.value,
              }))
            }
            type="date"
            value={filter.date_from}
          />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          To
          <input
            aria-label="Unbilled usage to date"
            className="mt-1 block h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                date_to: event.target.value,
              }))
            }
            type="date"
            value={filter.date_to}
          />
        </label>
        <button
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          type="submit"
        >
          Apply dates
        </button>
      </form>

      {reportQuery.isLoading ? (
        <LoadingSpinner label="Loading unbilled cath usage" />
      ) : reportQuery.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {reportQuery.error instanceof Error
            ? reportQuery.error.message
            : "Unbilled cath usage could not be loaded"}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            compact
            description="Mapped usage is billed through the billing-event path; only unresolved gaps appear here."
            title="No unbilled cath usage in this period"
          />
        </div>
      ) : (
        <UnbilledUsageTable items={items} />
      )}

      {total > 0 ? (
        <nav
          aria-label="Unbilled usage pagination"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <p className="text-sm text-muted-foreground">
            Showing {firstRow}–{lastRow} of {total} unresolved usage rows · Page{" "}
            {currentPage} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={currentPage <= 1 || reportQuery.isFetching}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              type="button"
            >
              Previous
            </button>
            <button
              className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                currentPage >= totalPages ||
                totalPages === 0 ||
                reportQuery.isFetching
              }
              onClick={() => setPage((value) => value + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function UnbilledUsageTable({
  items,
}: {
  items: CathConsumableUnbilledUsageItem[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[1100px] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Used at</th>
            <th className="px-4 py-3 font-medium">Patient</th>
            <th className="px-4 py-3 font-medium">Case / procedure</th>
            <th className="px-4 py-3 font-medium">Item</th>
            <th className="px-4 py-3 text-right font-medium">Quantity</th>
            <th className="px-4 py-3 font-medium">Usage</th>
            <th className="px-4 py-3 font-medium">Billing gap</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => (
            <tr key={item.usage_id}>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                {formatDateTime(item.used_at)}
              </td>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">
                  {item.patient_name ?? "Patient name unavailable"}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {item.patient_uid}
                </p>
              </td>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">
                  Case #{item.case_id}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.procedure_log_id
                    ? `Procedure #${item.procedure_log_id}`
                    : "No procedure log"}
                </p>
              </td>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{item.item_name}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {item.category.replaceAll("_", " ")}
                </p>
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums">
                {item.quantity}
              </td>
              <td className="px-4 py-3">
                {item.wasted ? (
                  <>
                    <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-medium text-rose-900 dark:bg-rose-950/50 dark:text-rose-200">
                      Wasted
                    </span>
                    <p className="mt-1 max-w-48 text-xs text-muted-foreground">
                      {item.waste_reason ?? "Reason not recorded"}
                    </p>
                  </>
                ) : (
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
                    Used
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <span className="inline-block max-w-64 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                  {item.billing_gap_reason}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
