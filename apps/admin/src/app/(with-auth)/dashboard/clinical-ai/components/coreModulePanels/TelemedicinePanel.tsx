"use client";

/**
 * Phase B1 — telemedicine admin panel.
 *
 * List recent teleconsultations + create a new one + status transitions
 * + generate pre-visit summary / note draft via the two teleconsult AI
 * modules. Drafts flow into the existing /reviews surface.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, MessageCircle, Plus, RefreshCw, Send, Video } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  createTeleconsultation,
  generateTeleconsultNoteDraft,
  generateTeleconsultPreVisitSummary,
  listTeleconsultations,
  transitionTeleconsultation,
  type TeleconsultAiResult,
  type Teleconsultation,
  type TeleconsultStatus,
  type TeleconsultType,
} from "@/lib/api/clinicalAiAdmin";

const STATUS_TRANSITIONS: Record<TeleconsultStatus, TeleconsultStatus[]> = {
  scheduled: ["waiting", "in_progress", "cancelled", "no_show"],
  waiting: ["in_progress", "cancelled", "no_show", "failed"],
  in_progress: ["completed", "failed"],
  completed: [],
  cancelled: [],
  no_show: [],
  failed: [],
};

function statusBadgeClass(status: TeleconsultStatus) {
  if (status === "completed") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "in_progress") return "bg-blue-100 text-blue-800 border-blue-200";
  if (status === "waiting") return "bg-amber-100 text-amber-800 border-amber-200";
  if (status === "cancelled" || status === "no_show" || status === "failed") {
    return "bg-rose-100 text-rose-800 border-rose-200";
  }
  return "bg-slate-100 text-slate-700 border-slate-200";
}

export function TelemedicinePanel() {
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<TeleconsultStatus | "">("");
  const [showCreate, setShowCreate] = useState(false);
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [consultType, setConsultType] = useState<TeleconsultType>("video");
  const [scheduledStart, setScheduledStart] = useState("");
  const [patientUid, setPatientUid] = useState("");
  const [doctorUid, setDoctorUid] = useState("");
  const [aiResult, setAiResult] = useState<TeleconsultAiResult | null>(null);

  const teleconsultsQuery = useQuery({
    queryKey: ["telemedicine", "list", statusFilter],
    queryFn: () => listTeleconsultations(statusFilter ? { status: statusFilter } : {}),
  });

  const createMut = useMutation({
    mutationFn: () =>
      createTeleconsultation({
        patient_uid: patientUid.trim() || null,
        doctor_uid: doctorUid.trim() || null,
        consult_type: consultType,
        scheduled_start: scheduledStart ? new Date(scheduledStart).toISOString() : null,
        chief_complaint: chiefComplaint.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Teleconsultation created");
      setShowCreate(false);
      setChiefComplaint("");
      setScheduledStart("");
      setPatientUid("");
      setDoctorUid("");
      queryClient.invalidateQueries({ queryKey: ["telemedicine"] });
    },
    onError: (err: Error) => toast.error(err.message || "Create failed"),
  });

  const transitionMut = useMutation({
    mutationFn: (input: { id: number; nextStatus: TeleconsultStatus; reason?: string }) =>
      transitionTeleconsultation(input.id, {
        next_status: input.nextStatus,
        cancellation_reason: input.reason ?? null,
      }),
    onSuccess: () => {
      toast.success("Status updated");
      queryClient.invalidateQueries({ queryKey: ["telemedicine"] });
    },
    onError: (err: Error) => toast.error(err.message || "Transition failed"),
  });

  const preVisitMut = useMutation({
    mutationFn: (id: number) => generateTeleconsultPreVisitSummary({ teleconsultation_id: id }),
    onSuccess: (result) => {
      setAiResult(result);
      toast.success("Pre-visit summary drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Pre-visit summary failed"),
  });

  const noteDraftMut = useMutation({
    mutationFn: (id: number) => generateTeleconsultNoteDraft({ teleconsultation_id: id }),
    onSuccess: (result) => {
      setAiResult(result);
      toast.success("Note draft generated");
    },
    onError: (err: Error) => toast.error(err.message || "Note draft failed"),
  });

  const consults = teleconsultsQuery.data?.teleconsultations || [];

  return (
    <section className="space-y-3">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Video className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Telemedicine</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Provider-agnostic: video joins served via plugged-in provider configs (Zoom / Daily / Jitsi).
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TeleconsultStatus | "")}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">all statuses</option>
          {(["scheduled", "waiting", "in_progress", "completed", "cancelled", "no_show", "failed"] as TeleconsultStatus[]).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => teleconsultsQuery.refetch()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-muted/40"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          refresh
        </button>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
        >
          <Plus className="h-3.5 w-3.5" />
          {showCreate ? "Cancel" : "New consult"}
        </button>
      </div>

      {showCreate ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3 lg:grid-cols-12">
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">Type</span>
            <select
              value={consultType}
              onChange={(e) => setConsultType(e.target.value as TeleconsultType)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {(["video", "chat", "audio", "hybrid"] as TeleconsultType[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">Scheduled start</span>
            <input
              type="datetime-local"
              value={scheduledStart}
              onChange={(e) => setScheduledStart(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">Patient UID</span>
            <input
              value={patientUid}
              onChange={(e) => setPatientUid(e.target.value)}
              placeholder="UUID"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">Doctor UID</span>
            <input
              value={doctorUid}
              onChange={(e) => setDoctorUid(e.target.value)}
              placeholder="UUID"
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-12">
            <span className="text-muted-foreground">Chief complaint</span>
            <input
              value={chiefComplaint}
              onChange={(e) => setChiefComplaint(e.target.value)}
              placeholder="fever 3 days, mild cough"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <div className="lg:col-span-12 flex justify-end">
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {createMut.isPending ? "Creating..." : "Create consult"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">ID</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Scheduled</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Chief complaint</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {consults.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  {teleconsultsQuery.isLoading ? "Loading…" : "No teleconsultations"}
                </td>
              </tr>
            ) : null}
            {consults.map((c: Teleconsultation) => {
              const allowed = STATUS_TRANSITIONS[c.status] || [];
              return (
                <tr key={c.id}>
                  <td className="px-3 py-1.5 font-mono">#{c.id}</td>
                  <td className="px-3 py-1.5">{c.consult_type}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded border px-2 py-0.5 ${statusBadgeClass(c.status)}`}>{c.status}</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[0.65rem]">
                    {c.scheduled_start ? new Date(c.scheduled_start).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-1.5">{c.chief_complaint || "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-[0.65rem]">{c.patient_uid?.slice(0, 8) || "—"}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {allowed.map((nextStatus) => (
                        <button
                          key={nextStatus}
                          type="button"
                          disabled={transitionMut.isPending}
                          onClick={() =>
                            transitionMut.mutate({ id: c.id, nextStatus,
                              reason: nextStatus === "cancelled" || nextStatus === "no_show" ? "admin transition" : undefined })
                          }
                          className="rounded border border-border bg-card px-1.5 py-0.5 text-[0.65rem] hover:bg-muted/40 disabled:opacity-50"
                        >
                          → {nextStatus}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => preVisitMut.mutate(c.id)}
                        disabled={preVisitMut.isPending}
                        className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[0.65rem] text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                      >
                        <ClipboardList className="h-3 w-3" />
                        pre-visit
                      </button>
                      <button
                        type="button"
                        onClick={() => noteDraftMut.mutate(c.id)}
                        disabled={noteDraftMut.isPending}
                        className="inline-flex items-center gap-1 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[0.65rem] text-purple-800 hover:bg-purple-100 disabled:opacity-50"
                      >
                        <MessageCircle className="h-3 w-3" />
                        note draft
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {aiResult ? (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{aiResult.module_key}</span>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              {aiResult.review_status === "failed" ? "review: failed" : "review: pending"}
            </span>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">{aiResult.provider}</span>
            {aiResult.generation_id != null ? (
              <span className="text-xs text-muted-foreground">generation #{aiResult.generation_id}</span>
            ) : null}
            <span className="text-xs text-muted-foreground">consult #{aiResult.teleconsultation_id}</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed">
{JSON.stringify(aiResult.draft, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

export default TelemedicinePanel;
