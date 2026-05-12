// src/app/(with-auth)/dashboard/bmw/page.tsx
//
// Sprint 20 — Bio-medical waste register (BMW Rules 2016).
// Yellow / Red / White / Blue daily generation with monthly + annual
// rollups feeding SPCB Form IV.

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

interface BmwLog {
  id: number;
  log_date: string;
  log_time: string;
  source_dept: string;
  source_ward: string | null;
  destination: string;
  yellow_kg: string;
  red_kg: string;
  white_kg: string;
  blue_kg: string;
  total_kg: string;
  bag_count: number | null;
  manifest_no: string | null;
  cbwtf_operator: string | null;
  ceiling_exceeded: boolean;
}

interface BmwMonthly {
  month_start: string;
  yellow_kg: string;
  red_kg: string;
  white_kg: string;
  blue_kg: string;
  total_kg: string;
  log_entries: number;
  departments_logging: number;
}

interface BmwAnnual {
  year: number;
  total_collection_events: number;
  yellow_kg: string;
  red_kg: string;
  white_kg: string;
  blue_kg: string;
  total_kg: string;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

export default function BmwPage() {
  const qc = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const year = new Date().getFullYear();

  const { data: logs = [], isLoading } = useQuery<BmwLog[]>({
    queryKey: ["bmw", "logs"],
    queryFn: async () => unwrapList<BmwLog>(
      await fetchAdminAPI<unknown>(`/compliance/bmw/log?limit=100`),
    ),
    refetchInterval: 60_000,
  });

  const { data: monthly = [] } = useQuery<BmwMonthly[]>({
    queryKey: ["bmw", "monthly", year],
    queryFn: async () => unwrapList<BmwMonthly>(
      await fetchAdminAPI<unknown>(`/compliance/bmw/monthly?year=${year}`),
    ),
  });

  const { data: annual } = useQuery<BmwAnnual>({
    queryKey: ["bmw", "annual", year],
    queryFn: async () => unwrap<BmwAnnual>(
      await fetchAdminAPI<unknown>(`/compliance/bmw/annual?year=${year}`),
    ),
  });

  const exceededCount = logs.filter((l) => l.ceiling_exceeded).length;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Bio-medical Waste Register</h1>
        <p className="text-sm text-muted-foreground mt-1">
          BMW Rules 2016 — Schedule I colour-coded daily generation.
          Monthly rollup feeds SPCB Form IV annual return.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label={`Year ${year} kg`} value={annual?.total_kg ?? "—"} />
        <KpiCard label="Yellow" value={annual?.yellow_kg ?? "—"} tone="yellow" />
        <KpiCard label="Red" value={annual?.red_kg ?? "—"} tone="red" />
        <KpiCard label="White" value={annual?.white_kg ?? "—"} tone="white" />
        <KpiCard label="Blue" value={annual?.blue_kg ?? "—"} tone="blue" />
      </div>

      {exceededCount > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          ⚠ {exceededCount} log entr{exceededCount === 1 ? "y exceeds" : "ies exceed"} the
          daily category ceiling. Investigate before SPCB submission.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowLog(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          + New collection log
        </button>
      </div>

      {monthly.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground bg-muted/40">
            Monthly rollup ({year}) — feeds SPCB Form IV
          </div>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left p-2">Month</th>
                <th className="text-right p-2">Yellow</th>
                <th className="text-right p-2">Red</th>
                <th className="text-right p-2">White</th>
                <th className="text-right p-2">Blue</th>
                <th className="text-right p-2">Total</th>
                <th className="text-right p-2">Entries</th>
                <th className="text-right p-2">Depts</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month_start} className="border-t border-border">
                  <td className="p-2">
                    {new Date(m.month_start).toLocaleString("default", { month: "long" })}
                  </td>
                  <td className="p-2 text-right">{m.yellow_kg}</td>
                  <td className="p-2 text-right">{m.red_kg}</td>
                  <td className="p-2 text-right">{m.white_kg}</td>
                  <td className="p-2 text-right">{m.blue_kg}</td>
                  <td className="p-2 text-right font-semibold">{m.total_kg}</td>
                  <td className="p-2 text-right text-muted-foreground">{m.log_entries}</td>
                  <td className="p-2 text-right text-muted-foreground">{m.departments_logging}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isLoading && <LoadingSpinner />}
      {!isLoading && logs.length === 0 && (
        <EmptyState title="No collection logs yet. Start with the daily Yellow/Red/White/Blue handover." />
      )}

      {logs.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-2">Date / Time</th>
                <th className="text-left p-2">Source</th>
                <th className="text-left p-2">Dest</th>
                <th className="text-right p-2">Y</th>
                <th className="text-right p-2">R</th>
                <th className="text-right p-2">W</th>
                <th className="text-right p-2">B</th>
                <th className="text-right p-2">Total</th>
                <th className="text-left p-2">Manifest</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr
                  key={l.id}
                  className={`border-t border-border ${
                    l.ceiling_exceeded ? "bg-amber-500/10" : ""
                  }`}
                >
                  <td className="p-2 whitespace-nowrap">
                    {l.log_date}
                    <br />
                    <span className="text-xs text-muted-foreground">{l.log_time}</span>
                  </td>
                  <td className="p-2">
                    {l.source_dept}
                    {l.source_ward && (
                      <span className="text-xs text-muted-foreground"> / {l.source_ward}</span>
                    )}
                  </td>
                  <td className="p-2 text-xs uppercase">{l.destination}</td>
                  <td className="p-2 text-right">{l.yellow_kg}</td>
                  <td className="p-2 text-right">{l.red_kg}</td>
                  <td className="p-2 text-right">{l.white_kg}</td>
                  <td className="p-2 text-right">{l.blue_kg}</td>
                  <td className="p-2 text-right font-semibold">{l.total_kg}</td>
                  <td className="p-2 text-xs">
                    {l.manifest_no ?? <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showLog && (
        <BmwLogModal
          onClose={() => setShowLog(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["bmw"] });
            setShowLog(false);
          }}
        />
      )}
    </div>
  );
}

function BmwLogModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    source_dept: "",
    source_ward: "",
    destination: "cbwtf",
    yellow_kg: "0",
    red_kg: "0",
    white_kg: "0",
    blue_kg: "0",
    bag_count: "",
    vehicle_no: "",
    cbwtf_operator: "",
    manifest_no: "",
    weighed_by: "",
    received_by: "",
    notes: "",
  });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>("/compliance/bmw/log", {
      method: "POST",
      body: {
        ...form,
        yellow_kg: Number(form.yellow_kg),
        red_kg: Number(form.red_kg),
        white_kg: Number(form.white_kg),
        blue_kg: Number(form.blue_kg),
        bag_count: form.bag_count ? Number(form.bag_count) : undefined,
      },
    }),
    onSuccess: () => onSaved(),
  });

  const total = ["yellow_kg", "red_kg", "white_kg", "blue_kg"]
    .reduce((a, k) => a + Number(form[k as keyof typeof form] || 0), 0);
  const valid = form.source_dept.trim() && form.destination && total > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New BMW collection log</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <Field label="Source dept *" v={form.source_dept}
          on={(v) => setForm({ ...form, source_dept: v })} />
        <Field label="Source ward" v={form.source_ward}
          on={(v) => setForm({ ...form, source_ward: v })} />

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Destination *
          </label>
          <select
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="cssd">CSSD (in-hospital storage)</option>
            <option value="cbwtf">CBWTF (final dispatch)</option>
            <option value="incinerator">Incinerator (in-house)</option>
            <option value="autoclave">Autoclave</option>
            <option value="return_pharma">Return to manufacturer</option>
          </select>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {([
            ["yellow_kg", "Yellow", "bg-yellow-500/10"],
            ["red_kg", "Red", "bg-rose-500/10"],
            ["white_kg", "White", "bg-zinc-300/10"],
            ["blue_kg", "Blue", "bg-blue-500/10"],
          ] as const).map(([k, label, bg]) => (
            <div key={k} className={`rounded p-2 ${bg}`}>
              <label className="block text-xs">{label} kg</label>
              <input
                type="number"
                step="0.01"
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
          ))}
        </div>
        <div className="text-right text-sm">
          <span className="text-muted-foreground">Total: </span>
          <span className="font-semibold">{total.toFixed(2)} kg</span>
        </div>

        <Field label="Bag count" v={form.bag_count} type="number"
          on={(v) => setForm({ ...form, bag_count: v })} />
        <Field label="Vehicle no." v={form.vehicle_no}
          on={(v) => setForm({ ...form, vehicle_no: v })} />
        <Field label="CBWTF operator" v={form.cbwtf_operator}
          on={(v) => setForm({ ...form, cbwtf_operator: v })} />
        <Field label="Manifest no." v={form.manifest_no}
          on={(v) => setForm({ ...form, manifest_no: v })} />
        <Field label="Weighed by" v={form.weighed_by}
          on={(v) => setForm({ ...form, weighed_by: v })} />
        <Field label="Received by" v={form.received_by}
          on={(v) => setForm({ ...form, received_by: v })} />
        <Field label="Notes" v={form.notes} multiline
          on={(v) => setForm({ ...form, notes: v })} />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button
            type="button"
            disabled={!valid || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {m.isPending ? "Saving…" : "Save log"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label, value, tone,
}: {
  label: string;
  value: string | number;
  tone?: "yellow" | "red" | "white" | "blue";
}) {
  const toneClasses: Record<string, string> = {
    yellow: "border-yellow-500/30 bg-yellow-500/5",
    red: "border-rose-500/30 bg-rose-500/5",
    white: "border-zinc-300/30 bg-zinc-300/5",
    blue: "border-blue-500/30 bg-blue-500/5",
  };
  return (
    <div className={`rounded-lg border p-4 ${tone ? toneClasses[tone] : "border-border bg-card"}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Field({
  label, v, on, type = "text", multiline,
}: {
  label: string;
  v: string;
  on: (v: string) => void;
  type?: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      {multiline ? (
        <textarea rows={2} value={v} onChange={(e) => on(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      ) : (
        <input type={type} value={v} onChange={(e) => on(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      )}
    </div>
  );
}
