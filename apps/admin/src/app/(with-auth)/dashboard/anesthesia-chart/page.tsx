// src/app/(with-auth)/dashboard/anesthesia-chart/page.tsx
//
// Sprint 17 — anesthesia time-series chart viewer / entry. Looks up
// by ot_schedule_id; lists every-5-min entries with vitals + drugs +
// fluids and totals at the bottom.

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface ChartEntry {
  id: number;
  recorded_at: string;
  hr: number | null;
  sbp: number | null;
  dbp: number | null;
  map: number | null;
  spo2: number | null;
  etco2: number | null;
  rr: number | null;
  temp_c: number | null;
  vent_mode: string | null;
  fio2_pct: number | null;
  tidal_volume_ml: number | null;
  peep_cmh2o: number | null;
  airway_pressure: number | null;
  drugs_given: Array<{ name?: string; dose_mg?: number; route?: string; time?: string }> | null;
  iv_fluids_ml: number | null;
  blood_loss_ml: number | null;
  urine_output_ml: number | null;
  event_note: string | null;
}

interface ChartTotals {
  entries?: number;
  started?: string | null;
  ended?: string | null;
  total_iv_fluids_ml?: number;
  total_blood_loss_ml?: number;
  total_urine_output_ml?: number;
  min_map?: number | null;
  max_map?: number | null;
  min_spo2?: number | null;
  max_hr?: number | null;
  min_hr?: number | null;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

function fmtTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function AnesthesiaChartPage() {
  const qc = useQueryClient();
  const [scheduleIdInput, setScheduleIdInput] = useState("");
  const [scheduleId, setScheduleId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data: entries = [], isLoading } = useQuery<ChartEntry[]>({
    queryKey: ["anesthesia", "entries", scheduleId],
    queryFn: async () => {
      if (!scheduleId) return [];
      const r = await fetchAdminAPI<unknown>(
        `/anesthesia/entries/case/${scheduleId}`,
      );
      return unwrapList<ChartEntry>(r);
    },
    enabled: !!scheduleId,
    refetchInterval: 30_000,
  });

  const { data: totals } = useQuery<ChartTotals>({
    queryKey: ["anesthesia", "totals", scheduleId],
    queryFn: async () => {
      if (!scheduleId) return {};
      const r = await fetchAdminAPI<unknown>(
        `/anesthesia/totals/case/${scheduleId}`,
      );
      return unwrap<ChartTotals>(r);
    },
    enabled: !!scheduleId,
    refetchInterval: 30_000,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Anesthesia Chart</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Time-series chart for an OR case. Auto-refreshes every 30s.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(scheduleIdInput);
          if (Number.isFinite(n)) setScheduleId(n);
        }}
        className="flex gap-3 items-end flex-wrap"
      >
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            OR schedule ID
          </label>
          <input
            value={scheduleIdInput}
            onChange={(e) => setScheduleIdInput(e.target.value)}
            placeholder="e.g. 42"
            className="border border-border rounded-lg px-3 py-2 text-sm font-mono"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          Load
        </button>
        {scheduleId && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            + New entry
          </button>
        )}
      </form>

      {!scheduleId ? (
        <EmptyState
          title="Enter an OR schedule ID"
          description="The schedule ID is the ot_schedules.id of the surgical case."
        />
      ) : (
        <>
          {/* Totals */}
          {totals && (totals.entries ?? 0) > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <Tile label="Entries" value={String(totals.entries)} />
              <Tile label="IV fluids" value={`${totals.total_iv_fluids_ml ?? 0} mL`} />
              <Tile
                label="Blood loss"
                value={`${totals.total_blood_loss_ml ?? 0} mL`}
                alert={(totals.total_blood_loss_ml ?? 0) > 500}
              />
              <Tile label="Urine" value={`${totals.total_urine_output_ml ?? 0} mL`} />
              <Tile
                label="Min MAP"
                value={totals.min_map != null ? `${totals.min_map}` : "—"}
                alert={totals.min_map != null && totals.min_map < 60}
              />
              <Tile
                label="Min SpO2"
                value={totals.min_spo2 != null ? `${totals.min_spo2}%` : "—"}
                alert={totals.min_spo2 != null && totals.min_spo2 < 92}
              />
              <Tile
                label="HR range"
                value={
                  totals.min_hr != null && totals.max_hr != null
                    ? `${totals.min_hr}–${totals.max_hr}`
                    : "—"
                }
              />
            </div>
          )}

          {isLoading ? (
            <LoadingSpinner />
          ) : entries.length === 0 ? (
            <EmptyState
              title="No entries yet"
              description='Click "+ New entry" to record the first 5-minute slice.'
            />
          ) : (
            <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-muted-foreground border-b">
                  <tr className="text-left">
                    <th className="px-2 py-2">Time</th>
                    <th className="px-2 py-2">HR</th>
                    <th className="px-2 py-2">BP</th>
                    <th className="px-2 py-2">MAP</th>
                    <th className="px-2 py-2">SpO2</th>
                    <th className="px-2 py-2">EtCO2</th>
                    <th className="px-2 py-2">RR</th>
                    <th className="px-2 py-2">Temp</th>
                    <th className="px-2 py-2">Vent</th>
                    <th className="px-2 py-2">Drugs</th>
                    <th className="px-2 py-2">IV / loss / urine</th>
                    <th className="px-2 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const hypotension = e.map != null && e.map < 60;
                    const desat = e.spo2 != null && e.spo2 < 92;
                    const concerning = hypotension || desat;
                    return (
                      <tr
                        key={e.id}
                        className={`border-b last:border-0 ${
                          concerning ? "bg-rose-50" : ""
                        }`}
                      >
                        <td className="px-2 py-1 font-mono">{fmtTime(e.recorded_at)}</td>
                        <td className="px-2 py-1 font-mono">{e.hr ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">
                          {e.sbp && e.dbp ? `${e.sbp}/${e.dbp}` : "—"}
                        </td>
                        <td
                          className={`px-2 py-1 font-mono ${
                            hypotension ? "text-rose-700 font-bold" : ""
                          }`}
                        >
                          {e.map ?? "—"}
                        </td>
                        <td
                          className={`px-2 py-1 font-mono ${
                            desat ? "text-rose-700 font-bold" : ""
                          }`}
                        >
                          {e.spo2 != null ? `${e.spo2}%` : "—"}
                        </td>
                        <td className="px-2 py-1 font-mono">{e.etco2 ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{e.rr ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{e.temp_c ?? "—"}</td>
                        <td className="px-2 py-1">
                          {e.vent_mode ? (
                            <div>
                              <div>{e.vent_mode}</div>
                              <div className="text-muted-foreground">
                                FiO2 {e.fio2_pct ?? "—"}% · TV {e.tidal_volume_ml ?? "—"} · PEEP {e.peep_cmh2o ?? "—"}
                              </div>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-1">
                          {Array.isArray(e.drugs_given) && e.drugs_given.length > 0
                            ? e.drugs_given.map((d, i) => (
                                <div key={i}>
                                  {d.name}
                                  {d.dose_mg ? ` ${d.dose_mg}mg` : ""}
                                  {d.route ? ` ${d.route}` : ""}
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td className="px-2 py-1 font-mono">
                          {[
                            e.iv_fluids_ml != null ? `+${e.iv_fluids_ml}` : null,
                            e.blood_loss_ml != null ? `-${e.blood_loss_ml}` : null,
                            e.urine_output_ml != null ? `u${e.urine_output_ml}` : null,
                          ].filter(Boolean).join(" / ") || "—"}
                        </td>
                        <td className="px-2 py-1 max-w-xs truncate">
                          {e.event_note ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showAdd && scheduleId && (
        <NewEntryModal
          scheduleId={scheduleId}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["anesthesia"] });
          }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`bg-white rounded-lg border shadow-sm p-3 ${alert ? "border-rose-300" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold mt-1 font-mono ${alert ? "text-rose-700" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function NewEntryModal({
  scheduleId, onClose, onSaved,
}: {
  scheduleId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<{
    hr: string; sbp: string; dbp: string; spo2: string; etco2: string;
    rr: string; temp_c: string;
    vent_mode: string; fio2_pct: string; tidal_volume_ml: string; peep_cmh2o: string;
    iv_fluids_ml: string; blood_loss_ml: string; urine_output_ml: string;
    drugs_text: string; event_note: string;
  }>({
    hr: "", sbp: "", dbp: "", spo2: "", etco2: "", rr: "", temp_c: "",
    vent_mode: "", fio2_pct: "", tidal_volume_ml: "", peep_cmh2o: "",
    iv_fluids_ml: "", blood_loss_ml: "", urine_output_ml: "",
    drugs_text: "", event_note: "",
  });

  const mut = useMutation({
    mutationFn: async () => {
      // Parse drugs_text: each line "Name | Dose mg | Route" → {name, dose_mg, route}.
      const drugs = form.drugs_text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|").map((p) => p.trim());
          return {
            name: parts[0],
            dose_mg: parts[1] ? Number(parts[1]) : undefined,
            route: parts[2] ?? "IV",
          };
        });
      const body: Record<string, unknown> = {
        ot_schedule_id: scheduleId,
        drugs_given: drugs,
      };
      const numericKeys: Array<keyof typeof form> = [
        "hr", "sbp", "dbp", "spo2", "etco2", "rr", "temp_c",
        "fio2_pct", "tidal_volume_ml", "peep_cmh2o",
        "iv_fluids_ml", "blood_loss_ml", "urine_output_ml",
      ];
      for (const k of numericKeys) {
        const v = form[k];
        if (v !== "") body[k] = Number(v);
      }
      if (form.vent_mode) body.vent_mode = form.vent_mode;
      if (form.event_note) body.event_note = form.event_note;
      return fetchAdminAPI("/anesthesia/entries", {
        method: "POST",
        body: body,
      });
    },
    onSuccess: onSaved,
  });

  const errMsg = mut.error instanceof Error ? mut.error.message : null;

  function field(k: keyof typeof form, label: string, hint?: string) {
    return (
      <div>
        <label className="text-xs text-muted-foreground block mb-1">{label}</label>
        <input
          value={form[k]}
          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          className="w-full border border-border rounded-lg px-2 py-1 text-sm font-mono"
        />
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl mb-8">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">New chart entry</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Vitals</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {field("hr", "HR (bpm)")}
              {field("sbp", "SBP")}
              {field("dbp", "DBP")}
              {field("spo2", "SpO2 (%)")}
              {field("etco2", "EtCO2")}
              {field("rr", "RR")}
              {field("temp_c", "Temp (°C)")}
            </div>
          </section>
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Ventilation</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Mode</label>
                <select
                  value={form.vent_mode}
                  onChange={(e) => setForm({ ...form, vent_mode: e.target.value })}
                  className="w-full border border-border rounded-lg px-2 py-1 text-sm"
                >
                  <option value="">—</option>
                  <option value="volume_control">VC</option>
                  <option value="pressure_control">PC</option>
                  <option value="sims_v">SIMV</option>
                  <option value="spontaneous">Spontaneous</option>
                </select>
              </div>
              {field("fio2_pct", "FiO2 (%)")}
              {field("tidal_volume_ml", "TV (mL)")}
              {field("peep_cmh2o", "PEEP")}
            </div>
          </section>
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Fluids since last</p>
            <div className="grid grid-cols-3 gap-2">
              {field("iv_fluids_ml", "IV (mL)")}
              {field("blood_loss_ml", "Loss (mL)")}
              {field("urine_output_ml", "Urine (mL)")}
            </div>
          </section>
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
              Drugs given (one per line: <code>Name | Dose mg | Route</code>)
            </p>
            <textarea
              value={form.drugs_text}
              onChange={(e) => setForm({ ...form, drugs_text: e.target.value })}
              rows={3}
              placeholder={`Propofol | 100 | IV\nFentanyl | 50 | IV`}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </section>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Event note</label>
            <input
              value={form.event_note}
              onChange={(e) => setForm({ ...form, event_note: e.target.value })}
              placeholder="e.g. Intubation 7.5 cuffed ETT, easy"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Recording…" : "Record entry"}
          </button>
        </div>
      </div>
    </div>
  );
}
