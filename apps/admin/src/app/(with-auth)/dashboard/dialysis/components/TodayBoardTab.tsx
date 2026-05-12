// src/app/(with-auth)/dashboard/dialysis/components/TodayBoardTab.tsx

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
import { TodayRow, fmtTime, unwrapList } from "./types";

const STATUS_TONE: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-500/20 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-rose-500/15 text-rose-300",
  no_show: "bg-rose-500/10 text-rose-300",
};

export default function TodayBoardTab({
  onOpenSession,
}: {
  onOpenSession: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [showSchedule, setShowSchedule] = useState(false);

  const { data: rows = [], isLoading } = useQuery<TodayRow[]>({
    queryKey: ["dialysis", "today"],
    queryFn: async () => unwrapList<TodayRow>(
      await fetchAdminAPI<unknown>(`/dialysis/today`),
    ),
    refetchInterval: 30_000,
  });

  const start = useMutation({
    mutationFn: async (id: number) => fetchAdminAPI<unknown>(
      `/dialysis/sessions/${id}/start`, { method: "POST", body: {} },
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dialysis"] }),
  });

  const total = rows.length;
  const inProgress = rows.filter((r) => r.status === "in_progress").length;
  const isolation = rows.filter((r) => r.isolation_required).length;
  const events = rows.filter((r) => r.intra_dialytic_hypotension || r.cramps).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Today's sessions" value={total} />
        <Kpi label="In progress" value={inProgress} tone="active" />
        <Kpi label="Isolation room" value={isolation} tone="warning" />
        <Kpi label="With adverse events" value={events} tone="warning" />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowSchedule(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          + Schedule session
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && rows.length === 0 && (
        <EmptyState title="No dialysis sessions today." />
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Station</th>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Modality</th>
                <th className="text-left p-3">Access</th>
                <th className="text-left p-3">Schedule</th>
                <th className="text-left p-3">Actual</th>
                <th className="text-left p-3">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session_id} className="border-t border-border">
                  <td className="p-3 font-mono">
                    {r.station_no ?? "—"}
                    {r.machine_no && (
                      <div className="text-xs text-muted-foreground">{r.machine_no}</div>
                    )}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {r.patient_uid.slice(0, 8)}…
                    {r.isolation_required && (
                      <div className="mt-0.5 inline-block rounded bg-rose-500/15 text-rose-300 text-[10px] px-1.5 py-0.5">
                        ISOLATION
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-xs uppercase">{r.modality}</td>
                  <td className="p-3 text-xs">
                    {r.access_type ? r.access_type.replace(/_/g, " ") : "—"}
                  </td>
                  <td className="p-3 text-xs">{fmtTime(r.scheduled_start_at)}</td>
                  <td className="p-3 text-xs">
                    {r.actual_start_at && fmtTime(r.actual_start_at)}
                    {r.actual_end_at && (
                      <> – {fmtTime(r.actual_end_at)}</>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_TONE[r.status] ?? ""}`}>
                      {r.status.replace("_", " ")}
                    </span>
                    {(r.intra_dialytic_hypotension || r.cramps) && (
                      <span className="ml-1 text-xs text-amber-300">⚠</span>
                    )}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    {r.status === "scheduled" && (
                      <button
                        type="button"
                        disabled={start.isPending}
                        onClick={() => start.mutate(r.session_id)}
                        className="text-xs underline"
                      >
                        Start
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenSession(r.session_id)}
                      className="text-xs rounded bg-primary/20 px-2 py-1"
                    >
                      Open run →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showSchedule && (
        <ScheduleModal
          onClose={() => setShowSchedule(false)}
          onScheduled={() => {
            qc.invalidateQueries({ queryKey: ["dialysis"] });
            setShowSchedule(false);
          }}
        />
      )}
    </div>
  );
}

function ScheduleModal({
  onClose, onScheduled,
}: { onClose: () => void; onScheduled: () => void }) {
  const [form, setForm] = useState({
    dialysis_patient_id: "",
    session_date: new Date().toISOString().slice(0, 10),
    scheduled_start_at: "",
    machine_no: "",
    station_no: "",
    modality: "hd",
    dialyser: "",
    prescribed_uf_l: "",
  });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>("/dialysis/sessions", {
      method: "POST",
      body: {
        ...form,
        dialysis_patient_id: Number(form.dialysis_patient_id),
        prescribed_uf_l: form.prescribed_uf_l ? Number(form.prescribed_uf_l) : undefined,
      },
    }),
    onSuccess: () => onScheduled(),
  });

  const valid = form.dialysis_patient_id && form.session_date;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Schedule session</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <Field label="Dialysis patient ID *" v={form.dialysis_patient_id} type="number"
          on={(v) => setForm({ ...form, dialysis_patient_id: v })} />
        <Field label="Session date *" v={form.session_date} type="date"
          on={(v) => setForm({ ...form, session_date: v })} />
        <Field label="Scheduled start" v={form.scheduled_start_at} type="datetime-local"
          on={(v) => setForm({ ...form, scheduled_start_at: v })} />
        <Field label="Station no." v={form.station_no}
          on={(v) => setForm({ ...form, station_no: v })} />
        <Field label="Machine no." v={form.machine_no}
          on={(v) => setForm({ ...form, machine_no: v })} />

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Modality
          </label>
          <select value={form.modality}
            onChange={(e) => setForm({ ...form, modality: e.target.value })}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="hd">HD</option>
            <option value="hdf">HDF</option>
            <option value="pd_capd">PD CAPD</option>
            <option value="pd_apd">PD APD</option>
            <option value="crrt">CRRT</option>
            <option value="sled">SLED</option>
          </select>
        </div>

        <Field label="Dialyser" v={form.dialyser}
          on={(v) => setForm({ ...form, dialyser: v })} />
        <Field label="Prescribed UF (L)" v={form.prescribed_uf_l} type="number"
          on={(v) => setForm({ ...form, prescribed_uf_l: v })} />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label, value, tone,
}: { label: string; value: number; tone?: "warning" | "active" }) {
  const cls =
    tone === "warning" ? "border-amber-500/30 bg-amber-500/5"
    : tone === "active" ? "border-primary/30 bg-primary/5"
    : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-4 ${cls}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Field({
  label, v, on, type = "text",
}: { label: string; v: string; on: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      <input type={type} value={v} onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
    </div>
  );
}
