"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  CSSD_LOAD_STATUSES,
  listSterilizationLoads,
  type CssdLoad,
} from "@/lib/api/cssd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";
import { LoadStatusDialog, NewLoadDialog } from "./LoadActions";

/**
 * A load is only updatable while it is still open. `passed` and `failed` ARE
 * the release decision: deriveLoadStatus() re-derives `failed` from the
 * indicator results on every PATCH, so re-opening one means overwriting a
 * recorded biological/chemical indicator, which this console deliberately does
 * not offer. `cancelled` is closed.
 */
const OPEN_LOAD_STATUSES = new Set(["planned", "running", "completed"]);

export function LoadsTab() {
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CssdLoad | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "loads", { status }],
    queryFn: () =>
      listSterilizationLoads({ status: status || undefined, limit: 100 }),
  });

  const loads = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            Status
          </span>
          <select
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {CSSD_LOAD_STATUSES.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New load
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner label="Loading sterilization loads" />}

      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error.message}
        </div>
      )}

      {!isLoading && !error && loads.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState
            title="No sterilization loads recorded"
            description="Record a load to move returned sets back into circulation."
          />
        </div>
      )}

      {!isLoading && !error && loads.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Load</th>
                <th className="p-3 text-left">Cycle</th>
                <th className="p-3 text-left">Sets</th>
                <th className="p-3 text-left">Indicators</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Completed</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loads.map((load) => (
                <tr key={load.id} className="border-t border-border">
                  <td className="p-3">
                    <div className="font-medium">{load.load_code}</div>
                    <div className="text-xs text-muted-foreground">
                      {load.sterilizer_name ?? "Sterilizer not set"}
                    </div>
                  </td>
                  <td className="p-3 text-xs uppercase">
                    {load.cycle_type ?? "-"}
                  </td>
                  <td className="p-3 text-xs tabular-nums">
                    {(load.set_ids ?? []).length}
                  </td>
                  <td className="p-3 text-xs">
                    BI {load.biological_indicator_result ?? "-"} / CI{" "}
                    {load.chemical_indicator_result ?? "-"}
                  </td>
                  <td className="p-3">
                    <StatusPill status={load.status} />
                  </td>
                  <td className="p-3 text-xs">
                    {fmtDate(load.completed_at ?? load.created_at)}
                  </td>
                  <td className="p-3 text-right">
                    {OPEN_LOAD_STATUSES.has(load.status) ? (
                      <button
                        type="button"
                        onClick={() => setEditing(load)}
                        className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Update
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {humanize(load.status)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewLoadDialog onClose={() => setCreating(false)} />}
      {editing && (
        <LoadStatusDialog load={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
