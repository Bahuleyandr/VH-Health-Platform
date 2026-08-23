"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { describeGdprApiError, getErasureLog } from "@/lib/api/gdprErasure";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileSearch, RefreshCw } from "lucide-react";
import { useState } from "react";

const PAGE_SIZE = 50;

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ErasureLogTable() {
  const [offset, setOffset] = useState(0);

  const logQuery = useQuery({
    queryKey: ["gdpr-erasure", "log", offset],
    queryFn: () => getErasureLog({ limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });

  const rows = logQuery.data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Erasure log</h2>
        <button
          type="button"
          onClick={() => void logQuery.refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {logQuery.isLoading ? (
        <LoadingSpinner label="Loading erasure log..." />
      ) : logQuery.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {describeGdprApiError(logQuery.error).message}
        </div>
      ) : rows.length === 0 && offset === 0 ? (
        <div className="rounded-md border border-border bg-card">
          <EmptyState
            compact
            icon={<FileSearch className="h-10 w-10 text-muted-foreground" />}
            title="No erasures recorded"
            description="Completed GDPR erasures will appear here with who ran them, when, and why."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Requested by</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Tables</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(row.created_at)}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {row.uid ??
                      (row.phone_hash
                        ? `phone#${row.phone_hash.slice(0, 12)}…`
                        : "-")}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {row.requested_by ?? "-"}
                  </td>
                  <td className="max-w-72 px-3 py-3">{row.reason}</td>
                  <td className="px-3 py-3 text-xs">
                    {row.tables_processed ?? "-"}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {row.duration_ms != null ? `${row.duration_ms} ms` : "-"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(row.completed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="max-w-xl text-xs text-muted-foreground">
          The log lists entries only while the subject&apos;s user row still
          exists in this tenant — fully deleted subjects and phone-only erasures
          may not appear here even though they remain in the underlying audit
          table.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={offset === 0 || logQuery.isFetching}
            onClick={() => setOffset((prev) => Math.max(prev - PAGE_SIZE, 0))}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{offset + rows.length}
          </span>
          <button
            type="button"
            disabled={rows.length < PAGE_SIZE || logQuery.isFetching}
            onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
