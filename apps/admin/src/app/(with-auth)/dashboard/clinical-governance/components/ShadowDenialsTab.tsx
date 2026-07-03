"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, ShieldAlert } from "lucide-react";
import toast from "react-hot-toast";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  downloadPatientAccessShadowDenialsCsv,
  listPatientAccessShadowDenials,
  type PatientAccessShadowDenialRow,
} from "@/lib/api/clinicalGovernance";
import { ErrorBanner, fmt, Pill, SectionCard } from "./shared";

function dateInput(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ShadowDenialsTab() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState({
    date_from: dateInput(-13),
    date_to: dateInput(0),
  });
  const [exporting, setExporting] = useState(false);

  const reportQuery = useQuery({
    queryKey: ["clinical-governance", "patient-access-shadow-denials", filter],
    queryFn: () =>
      listPatientAccessShadowDenials({
        date_from: filter.date_from || undefined,
        date_to: filter.date_to || undefined,
      }),
  });
  const rows = reportQuery.data?.shadow_denials ?? [];

  async function handleExport() {
    setExporting(true);
    try {
      const blob = await downloadPatientAccessShadowDenialsCsv({
        date_from: filter.date_from || undefined,
        date_to: filter.date_to || undefined,
      });
      downloadBlob(blob, `shadow-denials-${filter.date_from || "all"}-to-${filter.date_to || "all"}.csv`);
      toast.success("Shadow-denials CSV exported");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <SectionCard
      title="Care-team shadow denials"
      icon={ShieldAlert}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "patient-access-shadow-denials"] })}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Exporting" : "Export CSV"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-4">
          <label className="text-xs text-muted-foreground">
            From
            <input
              aria-label="Shadow denial from date"
              type="date"
              value={filter.date_from}
              onChange={(event) => setFilter((current) => ({ ...current, date_from: event.target.value }))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input
              aria-label="Shadow denial to date"
              type="date"
              value={filter.date_to}
              onChange={(event) => setFilter((current) => ({ ...current, date_to: event.target.value }))}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
            <span className="block text-[11px] uppercase">Shadow denials</span>
            <strong className="text-lg">{reportQuery.data?.total_denials ?? 0}</strong>
          </div>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="block text-[11px] uppercase">Groups</span>
            <strong className="text-lg text-foreground">{reportQuery.data?.count ?? 0}</strong>
          </div>
        </div>
        <ErrorBanner error={reportQuery.error} />
        {reportQuery.isLoading ? (
          <LoadingSpinner label="Loading shadow denials" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="h-8 w-8 text-muted-foreground" />}
            title="No shadow denials"
            description="Would-be care-team denials in shadow mode will appear here."
            compact
          />
        ) : (
          <ShadowDenialsTable rows={rows} />
        )}
      </div>
    </SectionCard>
  );
}

function ShadowDenialsTable({ rows }: { rows: PatientAccessShadowDenialRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">day</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">actor role</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">resource family</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">denials</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">window</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={`${row.day}:${row.actor_role}:${row.resource_family}`}>
              <td className="px-3 py-2 font-mono">{row.day}</td>
              <td className="px-3 py-2">
                <Pill value={row.actor_role} />
              </td>
              <td className="px-3 py-2 font-medium">{row.resource_family}</td>
              <td className="px-3 py-2 text-rose-700 dark:text-rose-200">{row.denial_count}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {fmt(row.first_seen_at)} - {fmt(row.last_seen_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
