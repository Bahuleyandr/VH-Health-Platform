// src/app/(with-auth)/dashboard/maternity/page.tsx
//
// Maternity admin — Sprint 7. Active labour board + per-patient
// pregnancy lookup. Most chart-side work happens in the staff app;
// this is the admin view for day-to-day oversight.

"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface ActiveLabor {
  id: number;
  pregnancy_id: number;
  patient_uid: string;
  admitted_at: string;
  admission_reason: string | null;
  gestational_age_weeks: number | string | null;
  cervix_dilation_cm: number | string | null;
  cervix_effacement_pct: number | null;
  fetal_heart_rate_bpm: number | null;
  contractions_per_10min: number | null;
  membrane_status: string | null;
  status: string;
  gravida: number;
  parity: number;
  high_risk: boolean;
  high_risk_reasons: string[] | null;
}

interface PartographEntry {
  id: number;
  recorded_at: string;
  cervix_dilation_cm: number | string | null;
  fetal_heart_rate_bpm: number | null;
  contractions_per_10min: number | null;
  contractions_intensity: string | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse_bpm: number | null;
  on_alert_line: boolean | null;
  on_action_line: boolean | null;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function ageHours(s: string): string {
  const h = (Date.now() - new Date(s).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

function PartographDrilldown({
  laborId,
  onClose,
}: {
  laborId: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PartographEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetchAdminAPI<
          { data: PartographEntry[] } | PartographEntry[]
        >(`/maternity/partograph/labor/${laborId}`);
        const data = (r as { data?: PartographEntry[] }).data ?? (r as PartographEntry[]);
        setRows(Array.isArray(data) ? data : []);
      } finally {
        setLoading(false);
      }
    })();
  }, [laborId]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-4xl">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Partograph — Labor #{laborId}</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          {loading ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No partograph entries"
              description="The midwife hasn't recorded any assessments yet."
              compact
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr className="text-left">
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">Cervix</th>
                    <th className="px-2 py-2">FHR</th>
                    <th className="px-2 py-2">Ctx /10min</th>
                    <th className="px-2 py-2">BP</th>
                    <th className="px-2 py-2">Pulse</th>
                    <th className="px-2 py-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className={`border-b last:border-0 ${
                        r.on_action_line
                          ? "bg-rose-50"
                          : r.on_alert_line
                            ? "bg-amber-50"
                            : ""
                      }`}
                    >
                      <td className="px-2 py-2 text-xs">{fmtTs(r.recorded_at)}</td>
                      <td className="px-2 py-2 font-mono">
                        {r.cervix_dilation_cm ?? "—"} cm
                      </td>
                      <td className="px-2 py-2 font-mono">{r.fetal_heart_rate_bpm ?? "—"}</td>
                      <td className="px-2 py-2 text-xs">
                        {r.contractions_per_10min ?? "—"}
                        {r.contractions_intensity ? ` · ${r.contractions_intensity}` : ""}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">
                        {r.bp_systolic && r.bp_diastolic
                          ? `${r.bp_systolic}/${r.bp_diastolic}`
                          : "—"}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">{r.pulse_bpm ?? "—"}</td>
                      <td className="px-2 py-2 space-x-1">
                        {r.on_action_line && (
                          <span className="px-1.5 py-0.5 rounded bg-rose-200 text-rose-900 text-xs font-medium">
                            ACTION
                          </span>
                        )}
                        {r.on_alert_line && !r.on_action_line && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-medium">
                            ALERT
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MaternityPage() {
  const [rows, setRows] = useState<ActiveLabor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<number | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: ActiveLabor[] } | ActiveLabor[]>(
        "/maternity/labor-admissions/active?limit=50",
      );
      const data = (r as { data?: ActiveLabor[] }).data ?? (r as ActiveLabor[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load labour board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const i = setInterval(fetch, 60_000);
    return () => clearInterval(i);
  }, [fetch]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Maternity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Active labour board. Click a row to view the WHO modified partograph.
          </p>
        </div>
        <button
          onClick={fetch}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Labour ward is quiet"
          description="No active labour admissions right now."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">G/P</th>
                <th className="px-3 py-2">Risk</th>
                <th className="px-3 py-2">Admitted</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">GA</th>
                <th className="px-3 py-2">Cervix</th>
                <th className="px-3 py-2">Membranes</th>
                <th className="px-3 py-2">FHR</th>
                <th className="px-3 py-2">Ctx</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 hover:bg-muted/40 ${
                    r.high_risk ? "bg-amber-50" : ""
                  }`}
                >
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    G{r.gravida}P{r.parity}
                  </td>
                  <td className="px-3 py-2">
                    {r.high_risk ? (
                      <span
                        className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium"
                        title={(r.high_risk_reasons ?? []).join(", ")}
                      >
                        ⚠ high
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{fmtTs(r.admitted_at)}</div>
                    <div className="text-muted-foreground">{ageHours(r.admitted_at)} ago</div>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.admission_reason ?? "—"}</td>
                  <td className="px-3 py-2 font-mono">
                    {r.gestational_age_weeks ?? "—"}w
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {r.cervix_dilation_cm ?? "—"}cm
                    {r.cervix_effacement_pct != null && (
                      <span className="text-muted-foreground">
                        {" "}
                        / {r.cervix_effacement_pct}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.membrane_status ?? "—"}</td>
                  <td className="px-3 py-2 font-mono">
                    {r.fetal_heart_rate_bpm ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {r.contractions_per_10min ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setDrilldown(r.id)}
                      className="px-2 py-1 rounded border text-xs hover:bg-muted"
                    >
                      Partograph →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drilldown !== null && (
        <PartographDrilldown laborId={drilldown} onClose={() => setDrilldown(null)} />
      )}
    </div>
  );
}
