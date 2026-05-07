// src/app/(with-auth)/dashboard/ed-tracker/page.tsx
//
// Sprint 13 — ED tracking board. Backend (services/ed/edOperationsService
// + routes/admin/edRoutes.js) was already shipped; this is the admin
// surface that wires it up. Kanban-style columns by status with the
// status transition + triage actions inline.

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

interface EdVisit {
  id: number;
  visit_number: string;
  patient_uid: string | null;
  arrival_at: string;
  arrival_mode: string;
  chief_complaint: string | null;
  attending_doctor_uid: string | null;
  triage_priority: string | null;
  status: string;
  bed_assigned_id: number | null;
  disposition: string | null;
  triage_started_at: string | null;
  treatment_started_at: string | null;
  disposition_at: string | null;
  is_mlc: boolean;
}

const STATUS_ORDER: string[] = [
  "arriving",
  "in_triage",
  "awaiting_treatment",
  "in_treatment",
  "awaiting_disposition",
  "admitted",
  "discharged",
];

const STATUS_LABELS: Record<string, string> = {
  arriving: "Arriving",
  in_triage: "In triage",
  awaiting_treatment: "Awaiting bed",
  in_treatment: "In treatment",
  awaiting_disposition: "Awaiting disposition",
  admitted: "Admitted (boarding)",
  discharged: "Discharged",
  transferred: "Transferred",
  left_against_advice: "LAMA",
  lwbs: "LWBS",
  expired: "Expired",
};

const PRIORITY_COLOURS: Record<string, string> = {
  esi_1: "bg-rose-200 text-rose-900 border-rose-400",
  esi_2: "bg-rose-100 text-rose-800 border-rose-300",
  esi_3: "bg-amber-100 text-amber-800 border-amber-300",
  esi_4: "bg-emerald-100 text-emerald-800 border-emerald-300",
  esi_5: "bg-slate-100 text-slate-700 border-slate-300",
  manchester_red: "bg-rose-200 text-rose-900 border-rose-400",
  manchester_orange: "bg-orange-100 text-orange-800 border-orange-300",
  manchester_yellow: "bg-amber-100 text-amber-800 border-amber-300",
  manchester_green: "bg-emerald-100 text-emerald-800 border-emerald-300",
  manchester_blue: "bg-blue-100 text-blue-800 border-blue-300",
};

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  if (Array.isArray(data)) return data as T[];
  for (const k of ["visits", "rows", "items"]) {
    const inner = (data as Record<string, unknown>)?.[k];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function fmtTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ageMinutes(s: string | null): number | null {
  if (!s) return null;
  const d = new Date(s).getTime();
  if (Number.isNaN(d)) return null;
  return Math.floor((Date.now() - d) / 60000);
}

function fmtAge(s: string | null): string {
  const m = ageMinutes(s);
  if (m == null) return "—";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${mm}m`;
}

export default function EdTrackerPage() {
  const qc = useQueryClient();
  const [editVisit, setEditVisit] = useState<EdVisit | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const { data: visits = [], error, isLoading } = useQuery<EdVisit[]>({
    queryKey: ["ed", "visits", "active"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/admin/ed/visits?openOnly=true&limit=200");
      return unwrapList<EdVisit>(r);
    },
    refetchInterval: 30_000,
  });

  const transitionMut = useMutation({
    mutationFn: async (vars: { id: number; status: string }) =>
      fetchAdminAPI(`/admin/ed/visits/${vars.id}/transition`, {
        method: "PATCH",
        body: JSON.stringify({ status: vars.status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ed"] }),
  });

  const priorityMut = useMutation({
    mutationFn: async (vars: { id: number; priority: string }) =>
      fetchAdminAPI(`/admin/ed/visits/${vars.id}/triage-priority`, {
        method: "PATCH",
        body: JSON.stringify({ triage_priority: vars.priority }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ed"] }),
  });

  // KPI strip values.
  const kpis = (() => {
    const open = visits.filter((v) => !["discharged", "admitted", "transferred", "lwbs", "left_against_advice", "expired"].includes(v.status));
    const inTreatment = visits.filter((v) => v.status === "in_treatment").length;
    const waiting = visits.filter((v) => v.status === "awaiting_treatment" || v.status === "in_triage").length;
    const boarders = visits.filter((v) => v.status === "admitted").length;
    const critical = visits.filter((v) =>
      v.triage_priority === "esi_1" ||
      v.triage_priority === "esi_2" ||
      v.triage_priority === "manchester_red" ||
      v.triage_priority === "manchester_orange",
    ).length;
    // Door-to-treatment median (very rough — median of (treatment_started_at − arrival_at) for those that started).
    const startedTimes = visits
      .filter((v) => v.treatment_started_at)
      .map((v) => new Date(v.treatment_started_at!).getTime() - new Date(v.arrival_at).getTime())
      .sort((a, b) => a - b);
    const median = startedTimes.length
      ? startedTimes[Math.floor(startedTimes.length / 2)]
      : null;
    const medianMin = median != null ? Math.round(median / 60000) : null;
    return {
      open: open.length,
      waiting,
      inTreatment,
      boarders,
      critical,
      medianMin,
    };
  })();

  // Group by status for the column view.
  const byStatus = STATUS_ORDER.reduce<Record<string, EdVisit[]>>((acc, s) => {
    acc[s] = visits.filter((v) => v.status === s);
    return acc;
  }, {});

  const errMsg = (error ?? transitionMut.error ?? priorityMut.error)?.toString();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">ED Tracking Board</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live emergency department flow. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowRegister(true)}
            className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
          >
            + Register arrival
          </button>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["ed"] })}
            className="px-3 py-1.5 rounded-md border text-foreground hover:bg-muted text-xs"
          >
            Refresh
          </button>
        </div>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Open visits", value: kpis.open },
          { label: "Waiting", value: kpis.waiting },
          { label: "In treatment", value: kpis.inTreatment },
          { label: "Boarders", value: kpis.boarders, alert: kpis.boarders > 5 },
          { label: "Critical (red/orange)", value: kpis.critical, alert: kpis.critical > 0 },
          {
            label: "Median door-to-treat",
            value: kpis.medianMin != null ? `${kpis.medianMin}m` : "—",
          },
        ].map((s) => (
          <div
            key={s.label}
            className={`bg-white rounded-lg border shadow-sm p-3 ${
              s.alert ? "border-rose-300" : ""
            }`}
          >
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p
              className={`text-xl font-semibold mt-1 ${
                s.alert ? "text-rose-600" : ""
              }`}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Kanban */}
      {isLoading && visits.length === 0 ? (
        <LoadingSpinner />
      ) : visits.length === 0 ? (
        <EmptyState title="ED is quiet" description="No active visits right now." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="bg-white rounded-lg border shadow-sm">
              <div className="px-3 py-2 bg-muted border-b text-xs font-semibold flex items-center justify-between">
                <span>{STATUS_LABELS[s]}</span>
                <span className="text-muted-foreground">{byStatus[s].length}</span>
              </div>
              <div className="p-2 space-y-2 max-h-[60vh] overflow-y-auto">
                {byStatus[s].map((v) => (
                  <VisitCard
                    key={v.id}
                    visit={v}
                    onClick={() => setEditVisit(v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail / actions modal */}
      {editVisit && (
        <VisitModal
          visit={editVisit}
          onClose={() => setEditVisit(null)}
          onTransition={(s) => transitionMut.mutate({ id: editVisit.id, status: s })}
          onPriority={(p) => priorityMut.mutate({ id: editVisit.id, priority: p })}
          busy={transitionMut.isPending || priorityMut.isPending}
        />
      )}

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onCreated={() => {
            setShowRegister(false);
            qc.invalidateQueries({ queryKey: ["ed"] });
          }}
        />
      )}
    </div>
  );
}

function VisitCard({ visit, onClick }: { visit: EdVisit; onClick: () => void }) {
  const ageM = ageMinutes(visit.arrival_at);
  const stale = ageM != null && ageM > 60 && (visit.status === "awaiting_treatment" || visit.status === "in_triage");
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded border-2 p-2 ${
        visit.triage_priority
          ? PRIORITY_COLOURS[visit.triage_priority] ?? "bg-white border-slate-200"
          : "bg-white border-slate-200"
      } ${stale ? "ring-2 ring-rose-400" : ""}`}
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono font-bold">{visit.visit_number}</span>
        {visit.is_mlc && (
          <span className="px-1.5 py-0 rounded bg-purple-200 text-purple-900 text-[10px] font-bold">
            MLC
          </span>
        )}
      </div>
      <p className="text-xs mt-1 line-clamp-2">{visit.chief_complaint ?? "—"}</p>
      <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
        <span>{fmtTime(visit.arrival_at)}</span>
        <span className={stale ? "text-rose-700 font-bold" : ""}>
          {fmtAge(visit.arrival_at)}
        </span>
      </div>
      {visit.triage_priority && (
        <p className="text-[10px] font-mono mt-1">
          {visit.triage_priority}
        </p>
      )}
    </button>
  );
}

function VisitModal({
  visit, onClose, onTransition, onPriority, busy,
}: {
  visit: EdVisit;
  onClose: () => void;
  onTransition: (status: string) => void;
  onPriority: (priority: string) => void;
  busy: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-xl">
        <div className="p-4 border-b flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Visit {visit.visit_number}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Arrived {fmtTime(visit.arrival_at)} · {fmtAge(visit.arrival_at)} ago
              {visit.is_mlc && " · MLC"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Chief complaint</p>
            <p>{visit.chief_complaint ?? "—"}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">Patient</p>
              <p className="font-mono">
                {visit.patient_uid ? visit.patient_uid.slice(0, 8) : "(unregistered)"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Arrival mode</p>
              <p>{visit.arrival_mode}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <p>{STATUS_LABELS[visit.status] ?? visit.status}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Priority</p>
              <p className="font-mono">{visit.triage_priority ?? "unassigned"}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Set priority (ESI)</p>
            <div className="flex flex-wrap gap-1">
              {["esi_1", "esi_2", "esi_3", "esi_4", "esi_5"].map((p) => (
                <button
                  key={p}
                  onClick={() => onPriority(p)}
                  disabled={busy}
                  className={`px-2 py-1 rounded border text-xs ${
                    PRIORITY_COLOURS[p]
                  } disabled:opacity-40`}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Transition status</p>
            <div className="flex flex-wrap gap-1">
              {[
                "in_triage",
                "awaiting_treatment",
                "in_treatment",
                "awaiting_disposition",
                "admitted",
                "discharged",
                "transferred",
                "left_against_advice",
                "lwbs",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => onTransition(s)}
                  disabled={busy || s === visit.status}
                  className="px-2 py-1 rounded border text-xs hover:bg-muted disabled:opacity-30"
                >
                  → {STATUS_LABELS[s] ?? s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RegisterModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    patient_uid: "",
    arrival_mode: "walk_in",
    chief_complaint: "",
    is_mlc: false,
  });
  const mut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/admin/ed/visits", {
        method: "POST",
        body: JSON.stringify({
          patient_uid: form.patient_uid || null,
          arrival_mode: form.arrival_mode,
          chief_complaint: form.chief_complaint || null,
          is_mlc: form.is_mlc,
        }),
      }),
    onSuccess: onCreated,
  });
  const errMsg = mut.error instanceof Error ? mut.error.message : null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Register ED arrival</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Patient UID (optional — leave blank for unregistered)
            </label>
            <input
              value={form.patient_uid}
              onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Arrival mode</label>
            <select
              value={form.arrival_mode}
              onChange={(e) => setForm({ ...form, arrival_mode: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="walk_in">Walk-in</option>
              <option value="ambulance">Ambulance (108 / private)</option>
              <option value="referral">Referral from outside</option>
              <option value="self">Self-driving</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Chief complaint</label>
            <textarea
              value={form.chief_complaint}
              onChange={(e) => setForm({ ...form, chief_complaint: e.target.value })}
              rows={3}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_mlc}
              onChange={(e) => setForm({ ...form, is_mlc: e.target.checked })}
            />
            Medico-legal case (assault / RTA / poisoning / suicide attempt)
          </label>
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Registering…" : "Register"}
          </button>
        </div>
      </div>
    </div>
  );
}
