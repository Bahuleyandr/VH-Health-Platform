"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import {
  listDeteriorationSnapshots,
  type DeteriorationBand,
  type DeteriorationSnapshot,
} from "@/lib/api/clinicalAiAdmin";

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

function deteriorationBandClass(band: string) {
  if (band === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (band === "concerning") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function DeteriorationPanel() {
  const [bandFilter, setBandFilter] = useState<DeteriorationBand | "">("concerning");
  const snapshots = useQuery({
    queryKey: ["clinical-ai", "deterioration", bandFilter],
    queryFn: () => listDeteriorationSnapshots(bandFilter || undefined),
  });
  const rows: DeteriorationSnapshot[] = snapshots.data?.snapshots ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Deterioration Early Warning</h2>
        </div>
        <select
          value={bandFilter}
          onChange={(event) => setBandFilter(event.target.value as DeteriorationBand | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="critical">Critical only</option>
          <option value="concerning">Concerning + critical</option>
          <option value="watch">Watch</option>
          <option value="stable">Stable</option>
          <option value="">All bands</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Composite score (NEWS2 + trend + lab). Decision support; never silences a rule-based alarm.
      </p>
      {/* AD-H3: a failed load must never masquerade as "no deteriorating
          patients" — surface an explicit error with a retry, and a real
          loading state while the query is in flight. */}
      {snapshots.isError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <span>
            {snapshots.error instanceof Error
              ? `Failed to load deterioration snapshots: ${snapshots.error.message}`
              : "Failed to load deterioration snapshots"}
          </span>
          <button
            onClick={() => snapshots.refetch()}
            className="shrink-0 font-medium text-red-700 underline hover:text-red-900"
          >
            Retry
          </button>
        </div>
      ) : (
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Band</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Components</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top rec</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {snapshots.isLoading ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  Loading deterioration snapshots…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No snapshots in this band
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const topRec = row.recommendations?.[0];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-xs">{row.patient_uid}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${deteriorationBandClass(row.band)}`}>
                        {row.band}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{Number(row.score).toFixed(0)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      news {Number(row.news2_component).toFixed(0)} · trend {Number(row.trend_component).toFixed(0)} · lab {Number(row.lab_component).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-xs">{topRec?.message ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}

export default DeteriorationPanel;
