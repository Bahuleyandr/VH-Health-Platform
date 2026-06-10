"use client";

/**
 * AI Outcome Scoreboard (G3) — the per-module evidence read for
 * enable/disable and stage-promotion decisions, and the artifact shown to
 * NABH assessors and the hospital board. Strictly read-only: every number
 * is computed server-side from existing generation/review/safety tables.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Printer, ShieldAlert } from "lucide-react";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import {
  getAiOutcomeScoreboard,
  type AiOutcomeScoreboard,
  type ScoreboardModuleRow,
} from "@/lib/api/aiOutcomeScoreboard";

const PERIOD_OPTIONS = [30, 60, 90, 180, 365];

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value}%`;
}

function fmtMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 60) return `${value} min`;
  return `${(value / 60).toFixed(1)} h`;
}

function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return new Intl.NumberFormat("en-IN").format(value);
}

function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function deltaClass(delta: number | null): string {
  if (delta === null) return "text-muted-foreground";
  if (delta < 0) return "text-emerald-700";
  if (delta > 0) return "text-red-700";
  return "text-muted-foreground";
}

function TimeToSignCell({ row }: { row: ScoreboardModuleRow }) {
  if (!row.time_to_sign.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      {row.time_to_sign.map((tts) => (
        <div key={tts.note_type} className="text-xs">
          <span className="font-medium">{tts.note_type}</span>: {fmtMinutes(tts.ai_median_minutes)} vs{" "}
          {fmtMinutes(tts.baseline_median_minutes)}{" "}
          <span className={deltaClass(tts.median_delta_minutes)}>
            {tts.median_delta_minutes === null
              ? "(no baseline)"
              : `(${tts.median_delta_minutes > 0 ? "+" : ""}${tts.median_delta_minutes} min)`}
          </span>
          <span className="text-muted-foreground"> · n={tts.ai_signed_count}/{tts.baseline_signed_count}</span>
        </div>
      ))}
    </div>
  );
}

export default function AiOutcomeScoreboardPage() {
  const [periodDays, setPeriodDays] = useState<number>(90);
  const [moduleFilter, setModuleFilter] = useState<string>("");

  const scoreboard = useQuery({
    queryKey: ["clinical-ai", "outcome-scoreboard", periodDays],
    queryFn: () => getAiOutcomeScoreboard({ periodDays }),
  });

  const data: AiOutcomeScoreboard | undefined = scoreboard.data;
  const modules = useMemo(() => {
    const rows = data?.modules ?? [];
    if (!moduleFilter) return rows;
    return rows.filter((row) => row.module_key === moduleFilter);
  }, [data, moduleFilter]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-col gap-2 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">AI Outcome Scoreboard</h1>
            <p className="text-sm text-muted-foreground">
              Per-module evidence from review/safety/sign-off data — decision-support only, read-only.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={moduleFilter}
            onChange={(event) => setModuleFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Module filter"
          >
            <option value="">All modules</option>
            {(data?.modules ?? []).map((row) => (
              <option key={row.module_key} value={row.module_key}>
                {row.display_name || row.module_key}
              </option>
            ))}
          </select>
          <select
            value={periodDays}
            onChange={(event) => setPeriodDays(Number.parseInt(event.target.value, 10) || 90)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Period"
          >
            {PERIOD_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <Printer className="h-4 w-4" />
            Print evidence pack
          </button>
        </div>
      </div>

      {scoreboard.isLoading ? (
        <LoadingSpinner />
      ) : scoreboard.isError ? (
        <EmptyState
          title="Scoreboard unavailable"
          description={(scoreboard.error as Error)?.message || "Failed to load the AI outcome scoreboard."}
        />
      ) : !data ? (
        <EmptyState title="No data" description="No scoreboard payload returned." />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm text-muted-foreground">Acceptance ({data.period_days}d)</div>
              <div className="mt-1 text-2xl font-semibold">{fmtPct(data.totals.reviews.acceptance_rate_pct)}</div>
              <div className="text-xs text-muted-foreground">
                {fmtNumber(data.totals.reviews.accepted)} accepted / {fmtNumber(data.totals.reviews.decided)} decided ·
                used {fmtPct(data.totals.reviews.used_rate_pct)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm text-muted-foreground">Edit distance</div>
              <div className="mt-1 text-2xl font-semibold">{fmtPct(data.totals.edits.mean_edit_distance_pct)}</div>
              <div className="text-xs text-muted-foreground">
                median {fmtPct(data.totals.edits.median_edit_distance_pct)} · n={fmtNumber(data.totals.edits.sample_count)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm text-muted-foreground">Safety-flag precision</div>
              <div className="mt-1 text-2xl font-semibold">{fmtPct(data.totals.safety.flag_precision_pct)}</div>
              <div className="text-xs text-muted-foreground">
                override {fmtPct(data.totals.safety.flag_override_rate_pct)} · {fmtNumber(data.totals.safety.flagged_total)} flagged ·{" "}
                {fmtNumber(data.totals.safety.missed_reject_count)} missed
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm text-muted-foreground">Time-to-sign (avg)</div>
              <div className="mt-1 text-2xl font-semibold">
                {fmtMinutes(data.totals.time_to_sign.ai_avg_minutes)}
              </div>
              <div className="text-xs text-muted-foreground">
                baseline {fmtMinutes(data.totals.time_to_sign.baseline_avg_minutes)} · n=
                {fmtNumber(data.totals.time_to_sign.ai_signed_count)}/{fmtNumber(data.totals.time_to_sign.baseline_signed_count)}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Drafts</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Acceptance / used</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Edit distance</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Safety precision / override</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Time-to-sign vs baseline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {modules.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                      No AI module activity (or enabled modules) in this window
                    </td>
                  </tr>
                ) : (
                  modules.map((row) => (
                    <tr key={row.module_key}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.display_name || row.module_key}</div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono">{row.module_key}</span>
                          <span
                            className={`rounded border px-1 ${
                              row.enabled
                                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                : "border-slate-200 bg-slate-50 text-slate-600"
                            }`}
                          >
                            {row.enabled ? "enabled" : "disabled"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{fmtNumber(row.generations.total)}</div>
                        <div className="text-xs text-muted-foreground">
                          {fmtNumber(row.generations.ai_generated)} AI / {fmtNumber(row.generations.fallback)} fallback
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          {fmtPct(row.reviews.acceptance_rate_pct)} / {fmtPct(row.reviews.used_rate_pct)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtNumber(row.reviews.accepted)}a · {fmtNumber(row.reviews.edited)}e ·{" "}
                          {fmtNumber(row.reviews.rejected)}r · {fmtNumber(row.reviews.pending)} pending
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{fmtPct(row.edits.mean_edit_distance_pct)}</div>
                        <div className="text-xs text-muted-foreground">
                          median {fmtPct(row.edits.median_edit_distance_pct)} · n={fmtNumber(row.edits.sample_count)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          {fmtPct(row.safety.flag_precision_pct)} / {fmtPct(row.safety.flag_override_rate_pct)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtNumber(row.safety.flagged_total)} flagged · {fmtNumber(row.safety.missed_reject_count)} missed rejects
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <TimeToSignCell row={row} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Medication safety overrides (deterministic engine)</h2>
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              {fmtNumber(data.medication_safety.finding_count)} findings · {fmtNumber(data.medication_safety.blocker_count)} blockers ·{" "}
              {fmtNumber(data.medication_safety.overridden_count)} overridden ({fmtPct(data.medication_safety.override_rate_pct)})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Check type</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Findings</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Critical</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Blockers</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Overridden / rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.medication_safety.by_type.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-center text-muted-foreground" colSpan={5}>
                        No medication-safety findings in this window
                      </td>
                    </tr>
                  ) : (
                    data.medication_safety.by_type.map((row) => (
                      <tr key={row.review_type}>
                        <td className="px-4 py-2 font-mono text-xs">{row.review_type}</td>
                        <td className="px-4 py-2">{fmtNumber(row.finding_count)}</td>
                        <td className="px-4 py-2">{fmtNumber(row.critical_count)}</td>
                        <td className="px-4 py-2">{fmtNumber(row.blocker_count)}</td>
                        <td className="px-4 py-2">
                          {fmtNumber(row.overridden_count)} / {fmtPct(row.override_rate_pct)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <details className="rounded-lg border border-border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">Metric definitions (methodology for assessors)</summary>
            <dl className="mt-3 space-y-2">
              {Object.entries(data.definitions || {}).map(([key, definition]) => (
                <div key={key}>
                  <dt className="font-mono text-xs font-semibold">{key}</dt>
                  <dd className="text-xs text-muted-foreground">{definition}</dd>
                </div>
              ))}
            </dl>
          </details>

          <div className="text-xs text-muted-foreground">
            Window {fmtDateTime(data.period_start)} → {fmtDateTime(data.period_end)} · computed {fmtDateTime(data.computed_at)} ·
            “—” means no evidence yet, not 0%.
          </div>
        </>
      )}
    </div>
  );
}
