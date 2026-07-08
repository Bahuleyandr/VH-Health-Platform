"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, Shirt, Waves } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { getLinenBoard, type LinenCycle, type LinenParLevel } from "@/lib/api/linenLaundry";

const STATUS_TONE: Record<string, string> = {
  collection_requested: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  collected: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  in_laundry: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  returned: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  reconciled: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
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

function ParStatus({ row }: { row: LinenParLevel }) {
  if (row.below_par) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">
        <AlertTriangle className="h-3.5 w-3.5" />
        Short {Math.abs(row.par_delta)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 className="h-3.5 w-3.5" />
      On par
    </span>
  );
}

function ParTable({ rows }: { rows: LinenParLevel[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border">
        <EmptyState compact title="No linen par levels recorded" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="p-3 text-left">Ward</th>
            <th className="p-3 text-left">Item</th>
            <th className="p-3 text-right">Par</th>
            <th className="p-3 text-right">Actual</th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3 text-left">Last Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border">
              <td className="p-3">
                <div className="font-medium">{row.ward_name}</div>
              </td>
              <td className="p-3">
                <div className="font-medium">{row.display_name}</div>
                <div className="text-xs text-muted-foreground">{row.item_code} · {row.unit}</div>
              </td>
              <td className="p-3 text-right tabular-nums">{row.par_quantity}</td>
              <td className="p-3 text-right tabular-nums">{row.actual_quantity}</td>
              <td className="p-3"><ParStatus row={row} /></td>
              <td className="p-3 text-xs">{fmtDate(row.last_counted_at ?? row.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CycleTable({ rows }: { rows: LinenCycle[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border">
        <EmptyState compact title="No laundry cycles recorded" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="p-3 text-left">Cycle</th>
            <th className="p-3 text-left">Ward</th>
            <th className="p-3 text-left">Status</th>
            <th className="p-3 text-right">Soiled</th>
            <th className="p-3 text-right">Clean Return</th>
            <th className="p-3 text-left">Discrepancy</th>
            <th className="p-3 text-left">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cycle) => (
            <tr key={cycle.id} className="border-t border-border">
              <td className="p-3">
                <div className="font-medium">{cycle.cycle_code}</div>
                <div className="text-xs text-muted-foreground">{cycle.item_count} item types</div>
              </td>
              <td className="p-3">{cycle.ward_name}</td>
              <td className="p-3">
                <span className={`rounded px-2 py-1 text-xs ${statusTone(cycle.status)}`}>
                  {cycle.status.replace(/_/g, " ")}
                </span>
              </td>
              <td className="p-3 text-right tabular-nums">{cycle.soiled_collected_quantity}</td>
              <td className="p-3 text-right tabular-nums">{cycle.clean_returned_quantity}</td>
              <td className="p-3">
                {cycle.discrepancy_flag ? (
                  <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Flagged
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    Clear
                  </span>
                )}
              </td>
              <td className="p-3 text-xs">{fmtDate(cycle.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LinenLaundryPage() {
  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["linen-laundry", "board"],
    queryFn: () => getLinenBoard({ limit: 25 }),
    refetchInterval: 30_000,
  });

  const summary = data?.summary ?? {
    par_level_count: 0,
    below_par_count: 0,
    open_cycle_count: 0,
    discrepancy_cycle_count: 0,
    shortage_quantity: 0,
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-card">
            <Shirt className="h-5 w-5 text-cyan-700 dark:text-cyan-300" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Linen & Laundry</h1>
          </div>
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

      {isLoading && <LoadingSpinner label="Loading linen board" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Par Levels" value={summary.par_level_count} />
            <Kpi label="Below Par" value={summary.below_par_count} tone={summary.below_par_count > 0 ? "bad" : "good"} />
            <Kpi label="Open Cycles" value={summary.open_cycle_count} tone="warn" />
            <Kpi label="Discrepancies" value={summary.discrepancy_cycle_count} tone={summary.discrepancy_cycle_count > 0 ? "bad" : "default"} />
            <Kpi label="Shortage Qty" value={summary.shortage_quantity} tone={summary.shortage_quantity > 0 ? "bad" : "good"} />
          </div>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Shirt className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Ward Par Stock</h2>
            </div>
            <ParTable rows={data?.par_levels ?? []} />
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Waves className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Laundry Cycles</h2>
            </div>
            <CycleTable rows={data?.cycles ?? []} />
          </section>
        </>
      )}
    </div>
  );
}
