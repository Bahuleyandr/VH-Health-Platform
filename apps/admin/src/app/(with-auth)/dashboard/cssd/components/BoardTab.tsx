"use client";

// CSSD board — the surface that already rendered, now with the actions that can
// actually populate it.

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { getCssdBoard, type CssdIssue, type CssdLoad } from "@/lib/api/cssd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Kpi, StatusPill, fmtDate, humanize } from "./helpers";
import { IssueActionDialog, IssueSetDialog } from "./IssueActions";
import { IssueTable } from "./IssuesTab";
import { LoadStatusDialog } from "./LoadActions";

const OPEN_LOAD_STATUSES = new Set(["planned", "running", "completed"]);

export function BoardTab() {
  const [issuing, setIssuing] = useState(false);
  const [issueAction, setIssueAction] = useState<{
    issue: CssdIssue;
    transition: string;
  } | null>(null);
  const [loadEdit, setLoadEdit] = useState<CssdLoad | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "board"],
    queryFn: () => getCssdBoard(),
    refetchInterval: 30_000,
  });

  const summary = data?.summary ?? {};
  const activeIssues = data?.active_issues ?? [];
  const recentLoads = data?.recent_loads ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
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
          onClick={() => setIssuing(true)}
          className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Issue set
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
            <Kpi
              label="Available"
              value={summary.available_sets ?? 0}
              tone="good"
            />
            <Kpi
              label="In circulation"
              value={summary.sets_in_circulation ?? 0}
              tone="warn"
            />
            <Kpi
              label="Overdue returns"
              value={summary.overdue_returns ?? 0}
              tone={(summary.overdue_returns ?? 0) > 0 ? "bad" : "default"}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi
              label="Open loads"
              value={summary.open_loads ?? 0}
              tone="warn"
            />
            <Kpi
              label="Failed loads"
              value={summary.failed_loads ?? 0}
              tone={(summary.failed_loads ?? 0) > 0 ? "bad" : "default"}
            />
            <Kpi
              label="Sets needing reprocess"
              value={summary.sets_requiring_reprocessing ?? 0}
              tone={
                (summary.sets_requiring_reprocessing ?? 0) > 0
                  ? "bad"
                  : "default"
              }
            />
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Sets in circulation</h2>
            {activeIssues.length === 0 ? (
              <div className="rounded-lg border border-border">
                <EmptyState
                  compact
                  title="No sets in circulation"
                  description="Use Issue set to send a sterilized set to an OT case."
                />
              </div>
            ) : (
              <IssueTable
                rows={activeIssues}
                onAction={(issue, transition) =>
                  setIssueAction({ issue, transition })
                }
              />
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Recent loads</h2>
            {recentLoads.length === 0 ? (
              <div className="rounded-lg border border-border">
                <EmptyState
                  compact
                  title="No sterilization loads recorded"
                  description="Record one on the Loads tab."
                />
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
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLoads.map((load) => (
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
                              onClick={() => setLoadEdit(load)}
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
          </section>
        </>
      )}

      {issuing && <IssueSetDialog onClose={() => setIssuing(false)} />}
      {issueAction && (
        <IssueActionDialog
          issue={issueAction.issue}
          transition={issueAction.transition}
          onClose={() => setIssueAction(null)}
        />
      )}
      {loadEdit && (
        <LoadStatusDialog load={loadEdit} onClose={() => setLoadEdit(null)} />
      )}
    </div>
  );
}
