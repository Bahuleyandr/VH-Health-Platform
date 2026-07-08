"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { fetchAdminAPI } from "@/lib/api";

type CssdSummary = {
  total_sets?: number;
  available_sets?: number;
  sets_in_circulation?: number;
  sets_requiring_reprocessing?: number;
  open_loads?: number;
  failed_loads?: number;
  overdue_returns?: number;
};

type CssdIssue = {
  id: number;
  issue_code: string;
  status: string;
  set_code?: string;
  set_name?: string;
  procedure_name?: string;
  ot_room?: string;
  scheduled_date?: string;
  return_due_at?: string | null;
  issue_warning_codes?: string[];
};

type CssdLoad = {
  id: number;
  load_code: string;
  status: string;
  cycle_type?: string;
  sterilizer_name?: string | null;
  biological_indicator_result?: string;
  chemical_indicator_result?: string;
  completed_at?: string | null;
  created_at?: string;
};

type CssdBoard = {
  summary: CssdSummary;
  active_issues: CssdIssue[];
  recent_loads: CssdLoad[];
};

const STATUS_TONE: Record<string, string> = {
  available: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  sterilized: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  issued: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  in_theatre: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  returned: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  awaiting_sterilization: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  completed: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  planned: "bg-muted text-muted-foreground",
};

function fmtDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status?: string) {
  return STATUS_TONE[String(status || "").toLowerCase()] ?? "bg-muted text-muted-foreground";
}

function Kpi({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : tone === "bad"
          ? "border-rose-500/30 bg-rose-500/5"
          : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}

export default function CssdPage() {
  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<CssdBoard>({
    queryKey: ["cssd", "board"],
    queryFn: () => fetchAdminAPI<CssdBoard>("/cssd/board"),
    refetchInterval: 30_000,
  });

  const summary = data?.summary ?? {};
  const activeIssues = data?.active_issues ?? [];
  const recentLoads = data?.recent_loads ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">CSSD</h1>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {isLoading && <LoadingSpinner label="Loading CSSD board" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Total sets" value={summary.total_sets ?? 0} />
            <Kpi label="Available" value={summary.available_sets ?? 0} tone="good" />
            <Kpi label="In circulation" value={summary.sets_in_circulation ?? 0} tone="warn" />
            <Kpi label="Overdue returns" value={summary.overdue_returns ?? 0} tone={(summary.overdue_returns ?? 0) > 0 ? "bad" : "default"} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Open loads" value={summary.open_loads ?? 0} tone="warn" />
            <Kpi label="Failed loads" value={summary.failed_loads ?? 0} tone={(summary.failed_loads ?? 0) > 0 ? "bad" : "default"} />
            <Kpi label="Sets needing reprocess" value={summary.sets_requiring_reprocessing ?? 0} tone={(summary.sets_requiring_reprocessing ?? 0) > 0 ? "bad" : "default"} />
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Sets in circulation</h2>
            {activeIssues.length === 0 ? (
              <div className="rounded-lg border border-border">
                <EmptyState compact title="No sets in circulation" />
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="p-3 text-left">Set</th>
                      <th className="p-3 text-left">OT case</th>
                      <th className="p-3 text-left">Status</th>
                      <th className="p-3 text-left">Return due</th>
                      <th className="p-3 text-left">Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeIssues.map((issue) => (
                      <tr key={issue.id} className="border-t border-border">
                        <td className="p-3">
                          <div className="font-medium">{issue.set_code}</div>
                          <div className="text-xs text-muted-foreground">{issue.set_name}</div>
                        </td>
                        <td className="p-3">
                          <div>{issue.procedure_name ?? "-"}</div>
                          <div className="text-xs text-muted-foreground">{issue.ot_room ?? "No room"} {fmtDate(issue.scheduled_date)}</div>
                        </td>
                        <td className="p-3">
                          <span className={`rounded px-2 py-1 text-xs ${statusTone(issue.status)}`}>
                            {issue.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="p-3 text-xs">{fmtDate(issue.return_due_at)}</td>
                        <td className="p-3 text-xs">
                          {(issue.issue_warning_codes ?? []).length > 0
                            ? issue.issue_warning_codes?.join(", ")
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Recent loads</h2>
            {recentLoads.length === 0 ? (
              <div className="rounded-lg border border-border">
                <EmptyState compact title="No sterilization loads recorded" />
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="p-3 text-left">Load</th>
                      <th className="p-3 text-left">Cycle</th>
                      <th className="p-3 text-left">Indicators</th>
                      <th className="p-3 text-left">Status</th>
                      <th className="p-3 text-left">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLoads.map((load) => (
                      <tr key={load.id} className="border-t border-border">
                        <td className="p-3">
                          <div className="font-medium">{load.load_code}</div>
                          <div className="text-xs text-muted-foreground">{load.sterilizer_name ?? "Sterilizer not set"}</div>
                        </td>
                        <td className="p-3 text-xs uppercase">{load.cycle_type ?? "-"}</td>
                        <td className="p-3 text-xs">
                          BI {load.biological_indicator_result ?? "-"} / CI {load.chemical_indicator_result ?? "-"}
                        </td>
                        <td className="p-3">
                          <span className={`rounded px-2 py-1 text-xs ${statusTone(load.status)}`}>
                            {load.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="p-3 text-xs">{fmtDate(load.completed_at ?? load.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
