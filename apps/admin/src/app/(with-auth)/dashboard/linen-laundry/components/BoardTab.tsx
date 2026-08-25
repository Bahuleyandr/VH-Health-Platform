"use client";

// Linen board — the surface that already rendered, now with the actions that
// can actually populate it.

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getLinenBoard,
  linenCycleTransitions,
  type LinenCycle,
  type LinenParLevel,
} from "@/lib/api/linenLaundry";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw, Shirt, Waves } from "lucide-react";
import { useState } from "react";

import {
  CycleActionDialog,
  NewCycleDialog,
  transitionLabel,
  type CycleTransition,
} from "./CycleDialogs";
import { Kpi, ParStatus, fmtDate, humanize, statusTone } from "./helpers";
import { ParLevelDialog } from "./ParLevelDialog";

export function BoardTab() {
  const [parDialog, setParDialog] = useState<
    { mode: "create" } | { mode: "edit"; row: LinenParLevel } | null
  >(null);
  const [newCycle, setNewCycle] = useState(false);
  const [cycleAction, setCycleAction] = useState<{
    cycle: LinenCycle;
    transition: CycleTransition;
  } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
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
    <div className="space-y-6">
      <div className="flex justify-end">
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
            <Kpi
              label="Below Par"
              value={summary.below_par_count}
              tone={summary.below_par_count > 0 ? "bad" : "good"}
            />
            <Kpi
              label="Open Cycles"
              value={summary.open_cycle_count}
              tone="warn"
            />
            <Kpi
              label="Discrepancies"
              value={summary.discrepancy_cycle_count}
              tone={summary.discrepancy_cycle_count > 0 ? "bad" : "default"}
            />
            <Kpi
              label="Shortage Qty"
              value={summary.shortage_quantity}
              tone={summary.shortage_quantity > 0 ? "bad" : "good"}
            />
          </div>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Shirt className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Ward Par Stock</h2>
              </div>
              <button
                type="button"
                onClick={() => setParDialog({ mode: "create" })}
                className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Set par level
              </button>
            </div>
            <ParTable
              rows={data?.par_levels ?? []}
              onEdit={(row) => setParDialog({ mode: "edit", row })}
            />
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Waves className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Laundry Cycles</h2>
              </div>
              <button
                type="button"
                onClick={() => setNewCycle(true)}
                className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                New cycle
              </button>
            </div>
            <CycleTable
              rows={data?.cycles ?? []}
              onAction={(cycle, transition) =>
                setCycleAction({ cycle, transition })
              }
            />
          </section>
        </>
      )}

      {parDialog && (
        <ParLevelDialog
          row={parDialog.mode === "edit" ? parDialog.row : undefined}
          onClose={() => setParDialog(null)}
        />
      )}
      {newCycle && <NewCycleDialog onClose={() => setNewCycle(false)} />}
      {cycleAction && (
        <CycleActionDialog
          cycle={cycleAction.cycle}
          transition={cycleAction.transition}
          onClose={() => setCycleAction(null)}
        />
      )}
    </div>
  );
}

function ParTable({
  rows,
  onEdit,
}: {
  rows: LinenParLevel[];
  onEdit: (row: LinenParLevel) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border">
        <EmptyState
          compact
          title="No linen par levels recorded"
          description="Use Set par level to record what each ward should hold."
        />
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
            <th className="p-3 text-right">Actions</th>
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
                <div className="text-xs text-muted-foreground">
                  {row.item_code} · {row.unit}
                </div>
              </td>
              <td className="p-3 text-right tabular-nums">
                {row.par_quantity}
              </td>
              <td className="p-3 text-right tabular-nums">
                {row.actual_quantity}
              </td>
              <td className="p-3">
                <ParStatus row={row} />
              </td>
              <td className="p-3 text-xs">
                {fmtDate(row.last_counted_at ?? row.updated_at)}
              </td>
              <td className="p-3 text-right">
                <button
                  type="button"
                  onClick={() => onEdit(row)}
                  className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  Update count
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CycleTable({
  rows,
  onAction,
}: {
  rows: LinenCycle[];
  onAction: (cycle: LinenCycle, transition: CycleTransition) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border">
        <EmptyState
          compact
          title="No laundry cycles recorded"
          description="Use New cycle to raise a ward linen collection."
        />
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
            <th className="p-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cycle) => {
            const transitions = linenCycleTransitions(cycle.status);
            return (
              <tr key={cycle.id} className="border-t border-border">
                <td className="p-3">
                  <div className="font-medium">{cycle.cycle_code}</div>
                  <div className="text-xs text-muted-foreground">
                    {cycle.item_count} item types
                  </div>
                </td>
                <td className="p-3">{cycle.ward_name}</td>
                <td className="p-3">
                  <span
                    className={`rounded px-2 py-1 text-xs ${statusTone(cycle.status)}`}
                  >
                    {humanize(cycle.status)}
                  </span>
                </td>
                <td className="p-3 text-right tabular-nums">
                  {cycle.soiled_collected_quantity}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {cycle.clean_returned_quantity}
                </td>
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
                <td className="p-3">
                  {transitions.length === 0 ? (
                    <span className="block text-right text-xs text-muted-foreground">
                      Closed
                    </span>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-1">
                      {transitions.map((transition) => (
                        <button
                          key={transition}
                          type="button"
                          onClick={() =>
                            onAction(cycle, transition as CycleTransition)
                          }
                          className={`rounded border px-2 py-1 text-xs font-medium hover:bg-muted ${
                            transition === "cancelled"
                              ? "border-rose-500/40 text-rose-700 dark:text-rose-300"
                              : "border-border"
                          }`}
                        >
                          {transitionLabel(transition)}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
