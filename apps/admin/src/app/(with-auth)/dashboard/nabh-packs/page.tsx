"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  downloadNabhIndicatorsCsv,
  getNabhIndicators,
  type NabhPeriod,
} from "@/lib/api/nabhPacks";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Gauge } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

import { IndicatorsTable } from "./components/IndicatorsTable";
import { PeriodPackPanel } from "./components/PeriodPackPanel";
import { inputClass } from "./components/shared";
import { SnapshotsTable } from "./components/SnapshotsTable";

function defaultPeriod(): NabhPeriod {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const toIso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  return { from: toIso(first), to: toIso(now) };
}

/**
 * NABH accreditation packs (roadmap D4). Three read/produce surfaces:
 * live indicator computation for a period, frozen assessor period packs
 * (freeze -> CSV/PDF/JSON), and the read-only snapshot ledger.
 */
export default function NabhPacksPage() {
  const initial = useMemo(() => defaultPeriod(), []);
  const [fromInput, setFromInput] = useState(initial.from);
  const [toInput, setToInput] = useState(initial.to);
  // The period actually queried — set by the Compute button so half-edited
  // dates never fire requests.
  const [period, setPeriod] = useState<NabhPeriod | null>(null);

  const indicatorsQuery = useQuery({
    queryKey: ["nabh-indicators", period?.from, period?.to],
    queryFn: () => getNabhIndicators(period as NabhPeriod),
    enabled: period !== null,
  });

  const csvMutation = useMutation({
    mutationFn: () => downloadNabhIndicatorsCsv(period as NabhPeriod),
    onError: (err: Error) => toast.error(err.message || "Export failed"),
  });

  const periodValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fromInput) &&
    /^\d{4}-\d{2}-\d{2}$/.test(toInput) &&
    fromInput <= toInput;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            Quality · NABH
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">
            NABH Accreditation Packs
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Aggregate quality indicators only — no patient identifiers. Freeze
            a period to produce the assessor evidence pack.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              From
            </span>
            <input
              type="date"
              aria-label="Period from"
              className={inputClass}
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              To
            </span>
            <input
              type="date"
              aria-label="Period to"
              className={inputClass}
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => setPeriod({ from: fromInput, to: toInput })}
            disabled={!periodValid}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            <Gauge className="h-4 w-4" />
            Compute indicators
          </button>
          <button
            type="button"
            onClick={() => csvMutation.mutate()}
            disabled={!period || csvMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Indicators CSV
          </button>
        </div>
      </div>

      {!periodValid && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Enter a valid period — both dates required and from must not be after
          to.
        </div>
      )}

      {!period && (
        <EmptyState
          title="Pick a period"
          description="Choose from/to dates and compute the live indicator set. Every value is aggregate-only."
        />
      )}

      {period && (
        <>
          {indicatorsQuery.isLoading && (
            <LoadingSpinner label="Computing NABH indicators…" />
          )}
          {indicatorsQuery.error instanceof Error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {indicatorsQuery.error.message}
            </div>
          )}
          {indicatorsQuery.data && (
            <IndicatorsTable indicators={indicatorsQuery.data.indicators} />
          )}
          <PeriodPackPanel period={period} />
        </>
      )}

      <SnapshotsTable />
    </div>
  );
}
