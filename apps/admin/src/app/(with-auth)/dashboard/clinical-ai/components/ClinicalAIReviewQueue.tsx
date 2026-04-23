"use client";

// Generic clinical-AI review-queue panel. Used by the "simple" list+decide
// modules in the Phase-2 deferredModulePanels/ barrel. See
// deferredModulePanels/README.md for the full contract and two worked
// examples.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-hot-toast";

// ---------------------------------------------------------------------------
// Local formatting helpers — kept in sync with AIExpansionPanels.tsx.
// Re-implemented (rather than imported) so this file has zero coupling to
// the 7.8k-LOC bespoke-panel module.
// ---------------------------------------------------------------------------
function fmt(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function severityBadgeClass(severity: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function readableKey(value?: string | null) {
  return value ? value.replace(/_/g, " ") : "-";
}

// Re-exported so consumer panels can reuse the exact same visual language
// for severity pills in custom column renderers.
export { fmt, severityBadgeClass, readableKey };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type DecideActionVariant = "primary" | "success" | "danger" | "warning" | "muted";

export type DecideAction<TDecision extends string> = {
  value: TDecision;
  label: string;
  variant?: DecideActionVariant;
  promptForNote?: boolean;
};

export type FilterOption = { value: string; label: string };

export type FilterSpec = {
  key: string;
  label: string;
  kind: "select" | "text";
  options?: FilterOption[];
  placeholder?: string;
};

export type ColumnSpec<TRow> = {
  key: string;
  header: string;
  render?: (row: TRow) => ReactNode;
  accessor?: keyof TRow | ((row: TRow) => string | number | null | undefined);
  className?: string;
};

export type KpiSpec<TRow> = {
  label: string;
  compute: (rows: TRow[]) => string | number;
  helpText?: string;
};

export type ListResult = { count: number } & Record<string, unknown>;

export type ClinicalAIReviewQueueProps<TRow, TDecision extends string> = {
  title: string;
  /** e.g. 'pharmacogenomics_support' — used in query keys */
  moduleKey: string;
  icon?: ReactNode;
  description?: string;
  /**
   * Fetcher. Must return an envelope shaped like
   * `{ <rowsKey>: TRow[]; count: number }` so the queue can pluck rows.
   */
  listFn: (params: Record<string, unknown>) => Promise<ListResult>;
  /** e.g. 'advisories' — the plural key that holds the array inside listFn's result. */
  rowsKey: string;
  decideFn: (
    id: number | string,
    decision: TDecision,
    note?: string | null
  ) => Promise<unknown>;
  /** Default pulls row.id — override if the backend row uses a different field. */
  idAccessor?: (row: TRow) => number | string;
  filters?: FilterSpec[];
  defaultFilters?: Record<string, string>;
  columns: ColumnSpec<TRow>[];
  /** If empty/omitted, no decision column is rendered. */
  decideActions?: DecideAction<TDecision>[];
  kpis?: KpiSpec<TRow>[];
  /** Optional slot rendered between the KPI strip and the table. */
  evaluateForm?: ReactNode;
  emptyState?: string;
  rowKey?: (row: TRow) => string | number;
  defaultLimit?: number;
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function initialFilters(
  filters: FilterSpec[] | undefined,
  defaults: Record<string, string> | undefined
): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const spec of filters ?? []) {
    seed[spec.key] = defaults?.[spec.key] ?? "";
  }
  return seed;
}

function decideButtonClass(variant: DecideActionVariant | undefined) {
  switch (variant) {
    case "success":
      return "rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50";
    case "danger":
      return "rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50";
    case "warning":
      return "rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50";
    case "muted":
      return "rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50";
    case "primary":
    default:
      return "rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50";
  }
}

function defaultAccessorRender<TRow>(
  column: ColumnSpec<TRow>,
  row: TRow
): ReactNode {
  const { accessor } = column;
  if (!accessor) return "-";
  let value: unknown;
  if (typeof accessor === "function") {
    value = accessor(row);
  } else {
    value = (row as Record<string, unknown>)[accessor as string];
  }
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return value;
  return String(value);
}

function getRowId<TRow>(row: TRow, idAccessor?: (row: TRow) => number | string): number | string {
  if (idAccessor) return idAccessor(row);
  const candidate = (row as Record<string, unknown>).id;
  if (typeof candidate === "number" || typeof candidate === "string") {
    return candidate;
  }
  // If there's no id, return an opaque JSON key — this is a bug-detection
  // fallback; panels should always supply idAccessor when rows lack `id`.
  return JSON.stringify(row);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function ClinicalAIReviewQueue<TRow, TDecision extends string>(
  props: ClinicalAIReviewQueueProps<TRow, TDecision>
) {
  const {
    title,
    moduleKey,
    icon,
    description,
    listFn,
    rowsKey,
    decideFn,
    idAccessor,
    filters,
    defaultFilters,
    columns,
    decideActions,
    kpis,
    evaluateForm,
    emptyState = "No records found",
    rowKey,
    defaultLimit = 50,
  } = props;

  const queryClient = useQueryClient();
  const [filterState, setFilterState] = useState<Record<string, string>>(() =>
    initialFilters(filters, defaultFilters)
  );

  const invalidationKey = ["clinical-ai", moduleKey] as const;

  const query = useQuery({
    queryKey: ["clinical-ai", moduleKey, filterState],
    queryFn: async () => {
      const params: Record<string, unknown> = { limit: defaultLimit };
      for (const [key, value] of Object.entries(filterState)) {
        if (value !== "" && value !== undefined && value !== null) {
          params[key] = value;
        }
      }
      return listFn(params);
    },
  });

  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: number | string;
      decision: TDecision;
      note?: string | null;
    }) => decideFn(id, decision, note ?? null),
    onSuccess: () => {
      toast.success("Decision saved");
      queryClient.invalidateQueries({ queryKey: invalidationKey });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Decision failed");
    },
  });

  const data = query.data;
  // Pluck the rows array out of the list envelope by the consumer-supplied key.
  const rowsRaw = data ? (data as Record<string, unknown>)[rowsKey] : undefined;
  const rows: TRow[] = Array.isArray(rowsRaw) ? (rowsRaw as TRow[]) : [];

  const showDecisionColumn = Array.isArray(decideActions) && decideActions.length > 0;
  const decisionActions: DecideAction<TDecision>[] = decideActions ?? [];
  const columnCount = columns.length + (showDecisionColumn ? 1 : 0);

  const setFilter = (key: string, value: string) => {
    setFilterState((current) => ({ ...current, [key]: value }));
  };

  const handleDecide = (row: TRow, action: DecideAction<TDecision>) => {
    let note: string | null = null;
    if (action.promptForNote) {
      const prompted = window.prompt(`${action.label} note (optional)`);
      note = prompted ?? null;
    }
    decide.mutate({ id: getRowId(row, idAccessor), decision: action.value, note });
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        {filters && filters.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {filters.map((spec) => {
              const value = filterState[spec.key] ?? "";
              if (spec.kind === "select") {
                return (
                  <select
                    key={spec.key}
                    value={value}
                    onChange={(event) => setFilter(spec.key, event.target.value)}
                    className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                    aria-label={spec.label}
                  >
                    <option value="">{`All ${spec.label.toLowerCase()}`}</option>
                    {(spec.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <input
                  key={spec.key}
                  value={value}
                  onChange={(event) => setFilter(spec.key, event.target.value)}
                  placeholder={spec.placeholder ?? spec.label}
                  className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                  aria-label={spec.label}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}

      {kpis && kpis.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
          {kpis.map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="text-sm text-muted-foreground">{kpi.label}</div>
              <div className="mt-1 text-2xl font-semibold">
                {kpi.compute(rows)}
              </div>
              {kpi.helpText ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {kpi.helpText}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {evaluateForm ? <div>{evaluateForm}</div> : null}

      {query.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {(query.error as Error | undefined)?.message || "Failed to load"}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-4 py-3 text-left font-medium text-muted-foreground ${column.className ?? ""}`}
                >
                  {column.header}
                </th>
              ))}
              {showDecisionColumn ? (
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                  Decision
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {query.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={columnCount}
                >
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={columnCount}
                >
                  {emptyState}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = rowKey ? rowKey(row) : getRowId(row, idAccessor);
                return (
                  <tr key={String(key)}>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`px-4 py-3 ${column.className ?? ""}`}
                      >
                        {column.render
                          ? column.render(row)
                          : defaultAccessorRender(column, row)}
                      </td>
                    ))}
                    {showDecisionColumn ? (
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1.5">
                          {decisionActions.map((action) => (
                            <button
                              key={action.value}
                              onClick={() => handleDecide(row, action)}
                              disabled={decide.isPending}
                              className={decideButtonClass(action.variant)}
                              type="button"
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default ClinicalAIReviewQueue;
