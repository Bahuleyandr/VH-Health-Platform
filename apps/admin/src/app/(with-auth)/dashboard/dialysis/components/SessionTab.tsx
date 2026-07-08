// src/app/(with-auth)/dashboard/dialysis/components/SessionTab.tsx

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
import {
  CompletionResult,
  IntraObs,
  MachineQaLog,
  ReuseRegisterRow,
  SessionRow,
  fmtTime,
  unwrapList,
} from "./types";
import { dialysisRefetchMs } from "../realtime";

export default function SessionTab({ sessionId, subscribed }: { sessionId: number; subscribed: boolean }) {
  const qc = useQueryClient();
  const [showObs, setShowObs] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const [showReuse, setShowReuse] = useState(false);
  const [showMachineQa, setShowMachineQa] = useState(false);
  const [completionResult, setCompletionResult] = useState<CompletionResult | null>(null);

  // List filter — patient-by-id endpoint isn't ideal (we need session
  // detail), so re-list and find. For real prod we'd have GET
  // /dialysis/sessions/:id; for now reuse list.
  const { data: list = [] } = useQuery<SessionRow[]>({
    queryKey: ["dialysis", "session", sessionId],
    queryFn: async () => unwrapList<SessionRow>(
      await fetchAdminAPI<unknown>(`/dialysis/sessions?limit=200`),
    ),
    refetchInterval: dialysisRefetchMs(subscribed, 30_000),
  });

  const sess = list.find((s) => s.id === sessionId) ?? null;

  const { data: obs = [], isLoading } = useQuery<IntraObs[]>({
    queryKey: ["dialysis", "obs", sessionId],
    queryFn: async () => unwrapList<IntraObs>(
      await fetchAdminAPI<unknown>(`/dialysis/sessions/${sessionId}/obs`),
    ),
    refetchInterval: dialysisRefetchMs(subscribed, 30_000),
  });

  const { data: reuseRows = [] } = useQuery<ReuseRegisterRow[]>({
    queryKey: ["dialysis", "reuse-register", sessionId],
    queryFn: async () => unwrapList<ReuseRegisterRow>(
      await fetchAdminAPI<unknown>(`/dialysis/sessions/${sessionId}/reuse-register`),
    ),
    refetchInterval: dialysisRefetchMs(subscribed, 60_000),
  });

  const { data: qaLogs = [] } = useQuery<MachineQaLog[]>({
    queryKey: ["dialysis", "machine-qa", sessionId],
    queryFn: async () => unwrapList<MachineQaLog>(
      await fetchAdminAPI<unknown>(`/dialysis/machine-qa?session_id=${sessionId}`),
    ),
    refetchInterval: dialysisRefetchMs(subscribed, 60_000),
  });

  if (!sess) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-lg font-semibold">
              Session #{sess.id} · Station {sess.station_no ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              {sess.session_date} · {sess.modality.toUpperCase()}
              {sess.machine_no && ` · machine ${sess.machine_no}`}
          {sess.actual_start_at && (
                <> · started {fmtTime(sess.actual_start_at)}</>
              )}
              {sess.reuse_count != null && (
                <> · reuse {sess.reuse_count}</>
              )}
            </div>
          </div>
          <span className={`px-2 py-1 rounded text-xs ${
            sess.status === "in_progress" ? "bg-amber-500/20 text-amber-300" :
            sess.status === "completed" ? "bg-emerald-500/15 text-emerald-300" :
            "bg-muted text-muted-foreground"
          }`}>
            {sess.status.replace("_", " ")}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
          <Stat label="Pre weight" value={sess.pre_weight_kg ? `${sess.pre_weight_kg} kg` : "—"} />
          <Stat label="Post weight" value={sess.post_weight_kg ? `${sess.post_weight_kg} kg` : "—"} />
          <Stat label="Prescribed UF" value={sess.prescribed_uf_l ? `${sess.prescribed_uf_l} L` : "—"} />
          <Stat label="Actual UF" value={sess.actual_uf_l ? `${sess.actual_uf_l} L` : "—"} />
          {sess.duration_min && (
            <Stat label="Duration" value={`${sess.duration_min} min`} />
          )}
          {sess.urr_pct != null && (
            <Stat label="URR" value={`${sess.urr_pct}%`}
              tone={sess.urr_pct >= 65 ? "good" : "warn"} />
          )}
          {sess.ktv_calculated && (
            <Stat label="Kt/V" value={sess.ktv_calculated}
              tone={Number(sess.ktv_calculated) >= 1.2 ? "good" : "warn"} />
          )}
        </div>

        {(sess.intra_dialytic_hypotension || sess.cramps || sess.early_termination) && (
          <div className="mt-3 rounded bg-amber-500/10 p-2 text-sm text-amber-200">
            {sess.intra_dialytic_hypotension && "Intra-dialytic hypotension · "}
            {sess.cramps && "Cramps · "}
            {sess.early_termination && "Early termination"}
          </div>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={() => setShowReuse(true)}
          className="rounded border border-border px-4 py-2 text-sm">
          Reuse register
        </button>
        <button type="button" onClick={() => setShowMachineQa(true)}
          className="rounded border border-border px-4 py-2 text-sm">
          Machine QA
        </button>
        {sess.status === "in_progress" && (
          <>
            <button type="button" onClick={() => setShowObs(true)}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              + Log observation
            </button>
            <button type="button" onClick={() => setShowComplete(true)}
              className="rounded border border-emerald-500/40 text-emerald-300 px-4 py-2 text-sm">
              Complete session
            </button>
          </>
        )}
      </div>

      {completionResult && (
        <div className="rounded-lg border border-border p-3 text-sm">
          <div className="font-medium">Completion signals</div>
          {completionResult.machine_qa_warnings && completionResult.machine_qa_warnings.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-amber-300">
              {completionResult.machine_qa_warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-emerald-300">Machine QA clear.</div>
          )}
          {completionResult.billing_hook && (
            <div className="mt-2 text-xs text-muted-foreground">
              Billing hook: {completionResult.billing_hook.status}
              {completionResult.billing_hook.invoice_id && (
                <> · invoice #{completionResult.billing_hook.invoice_id}</>
              )}
            </div>
          )}
        </div>
      )}

      {isLoading && <LoadingSpinner />}
      {!isLoading && obs.length === 0 && (
        <EmptyState title="No intra-dialysis observations yet." />
      )}

      {obs.length > 0 && (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-muted/40 text-muted-foreground sticky top-0">
              <tr>
                <th className="text-left p-2">Time</th>
                <th className="p-2">BP</th>
                <th className="p-2">Pulse</th>
                <th className="p-2">SpO₂</th>
                <th className="p-2">Temp</th>
                <th className="p-2">Blood flow</th>
                <th className="p-2">UF rate</th>
                <th className="p-2">TMP</th>
                <th className="p-2">UF total</th>
                <th className="p-2">Event / intervention</th>
              </tr>
            </thead>
            <tbody>
              {obs.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="p-2 whitespace-nowrap">{fmtTime(o.recorded_at)}</td>
                  <td className="p-2 text-center">
                    {o.bp_systolic && o.bp_diastolic
                      ? `${o.bp_systolic}/${o.bp_diastolic}`
                      : "—"}
                  </td>
                  <td className="p-2 text-center">{o.pulse ?? "—"}</td>
                  <td className="p-2 text-center">{o.spo2 ?? "—"}</td>
                  <td className="p-2 text-center">{o.temp_c ?? "—"}</td>
                  <td className="p-2 text-center">{o.blood_flow_ml_min ?? "—"}</td>
                  <td className={`p-2 text-center ${
                    o.uf_rate_ml_hr && o.uf_rate_ml_hr > 1300 ? "text-rose-300 font-semibold" : ""
                  }`}>
                    {o.uf_rate_ml_hr ?? "—"}
                  </td>
                  <td className="p-2 text-center">{o.tmp_mmhg ?? "—"}</td>
                  <td className="p-2 text-center">{o.uf_total_ml ?? "—"}</td>
                  <td className="p-2">
                    {o.event_note}
                    {o.intervention && (
                      <div className="text-amber-300">
                        ↳ {o.intervention} {o.intervention_dose}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Reuse register</div>
            <button type="button" onClick={() => setShowReuse(true)} className="text-xs underline">
              Update
            </button>
          </div>
          {reuseRows.length === 0 ? (
            <div className="mt-2 text-sm text-muted-foreground">No dialyzer reuse register row yet.</div>
          ) : (
            <div className="mt-2 space-y-1 text-sm">
              {reuseRows.map((row) => (
                <div key={row.id} className="rounded border border-border/70 p-2">
                  <div className="font-mono text-xs">{row.dialyzer_serial}</div>
                  <div className="text-xs text-muted-foreground">
                    Cycle {row.reuse_cycle_count} · {row.integrity_test_result} · {row.status}
                  </div>
                  <div className="text-xs text-amber-300">{row.register_format_status.replace(/_/g, " ")}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Machine QA</div>
            <button type="button" onClick={() => setShowMachineQa(true)} className="text-xs underline">
              Record
            </button>
          </div>
          {qaLogs.length === 0 ? (
            <div className="mt-2 text-sm text-muted-foreground">No machine QA log attached.</div>
          ) : (
            <div className="mt-2 space-y-1 text-sm">
              {qaLogs.map((log) => (
                <div key={log.id} className="rounded border border-border/70 p-2">
                  <div className="font-mono text-xs">{log.machine_no}</div>
                  <div className={log.status === "passed" ? "text-xs text-emerald-300" : "text-xs text-amber-300"}>
                    {log.status} · disinfection {log.disinfection_completed ? "done" : "pending"} · ready {log.machine_ready ? "yes" : "no"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showObs && (
        <ObsModal
          sessionId={sessionId}
          onClose={() => setShowObs(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["dialysis", "obs"] });
            setShowObs(false);
          }}
        />
      )}

      {showComplete && (
        <CompleteModal
          sessionId={sessionId}
          onClose={() => setShowComplete(false)}
          onCompleted={(row) => {
            setCompletionResult(row);
            qc.invalidateQueries({ queryKey: ["dialysis"] });
            setShowComplete(false);
          }}
        />
      )}

      {showReuse && (
        <ReuseRegisterModal
          session={sess}
          onClose={() => setShowReuse(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["dialysis"] });
            setShowReuse(false);
          }}
        />
      )}

      {showMachineQa && (
        <MachineQaModal
          session={sess}
          onClose={() => setShowMachineQa(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["dialysis"] });
            setShowMachineQa(false);
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label, value, tone,
}: { label: string; value: string | number; tone?: "good" | "warn" }) {
  const cls =
    tone === "good" ? "text-emerald-300"
    : tone === "warn" ? "text-amber-300"
    : "";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function ObsModal({
  sessionId, onClose, onSaved,
}: { sessionId: number; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({});

  const setF = (k: string) => (v: string) => setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === "") continue;
        const num = Number(v);
        body[k] = (k === "event_note" || k === "intervention" || k === "intervention_dose")
          ? v : (Number.isFinite(num) ? num : v);
      }
      return fetchAdminAPI<unknown>(`/dialysis/sessions/${sessionId}/obs`, {
        method: "POST", body: body,
      });
    },
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">+ Intra-dialysis observation</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <NumF label="SBP" v={form.bp_systolic} on={setF("bp_systolic")} />
          <NumF label="DBP" v={form.bp_diastolic} on={setF("bp_diastolic")} />
          <NumF label="Pulse" v={form.pulse} on={setF("pulse")} />
          <NumF label="SpO₂" v={form.spo2} on={setF("spo2")} />
          <NumF label="Temp °C" v={form.temp_c} on={setF("temp_c")} step="0.1" />
          <NumF label="Blood flow (mL/min)" v={form.blood_flow_ml_min} on={setF("blood_flow_ml_min")} />
          <NumF label="UF rate (mL/hr)" v={form.uf_rate_ml_hr} on={setF("uf_rate_ml_hr")} />
          <NumF label="TMP" v={form.tmp_mmhg} on={setF("tmp_mmhg")} />
          <NumF label="Art P" v={form.arterial_pressure} on={setF("arterial_pressure")} />
          <NumF label="Ven P" v={form.venous_pressure} on={setF("venous_pressure")} />
          <NumF label="UF total (mL)" v={form.uf_total_ml} on={setF("uf_total_ml")} />
          <NumF label="Conductivity" v={form.conductivity_ms_cm} on={setF("conductivity_ms_cm")} step="0.1" />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Event note
          </label>
          <textarea rows={2} value={form.event_note ?? ""}
            onChange={(e) => setF("event_note")(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Intervention" v={form.intervention ?? ""} on={setF("intervention")}
            placeholder="e.g. saline 200 mL" />
          <Field label="Dose / amount" v={form.intervention_dose ?? ""} on={setF("intervention_dose")} />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompleteModal({
  sessionId, onClose, onCompleted,
}: { sessionId: number; onClose: () => void; onCompleted: (row: CompletionResult) => void }) {
  const [form, setForm] = useState({
    post_weight_kg: "",
    post_bp_systolic: "",
    post_bp_diastolic: "",
    post_pulse: "",
    actual_uf_l: "",
    urea_pre_mg_dl: "",
    urea_post_mg_dl: "",
    intra_dialytic_hypotension: false,
    cramps: false,
    bleeding: false,
    clotting: false,
    early_termination: false,
    early_termination_reason: "",
    notes: "",
  });

  const setF = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<CompletionResult>(
      `/dialysis/sessions/${sessionId}/complete`,
      {
        method: "POST",
        body: {
          ...form,
          post_weight_kg: form.post_weight_kg ? Number(form.post_weight_kg) : undefined,
          post_bp_systolic: form.post_bp_systolic ? Number(form.post_bp_systolic) : undefined,
          post_bp_diastolic: form.post_bp_diastolic ? Number(form.post_bp_diastolic) : undefined,
          post_pulse: form.post_pulse ? Number(form.post_pulse) : undefined,
          actual_uf_l: form.actual_uf_l ? Number(form.actual_uf_l) : undefined,
          urea_pre_mg_dl: form.urea_pre_mg_dl ? Number(form.urea_pre_mg_dl) : undefined,
          urea_post_mg_dl: form.urea_post_mg_dl ? Number(form.urea_post_mg_dl) : undefined,
        },
      }),
    onSuccess: (row) => onCompleted(row),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Complete session</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <div className="text-xs text-muted-foreground">
          Kt/V (Daugirdas single-pool) auto-computed from urea pre/post +
          duration + UF + post-weight. URR auto-computed from urea pre/post.
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Post weight (kg)" v={form.post_weight_kg} type="number"
            on={(v) => setF("post_weight_kg", v)} />
          <Field label="Actual UF (L)" v={form.actual_uf_l} type="number"
            on={(v) => setF("actual_uf_l", v)} />
          <Field label="Post SBP" v={form.post_bp_systolic} type="number"
            on={(v) => setF("post_bp_systolic", v)} />
          <Field label="Post DBP" v={form.post_bp_diastolic} type="number"
            on={(v) => setF("post_bp_diastolic", v)} />
          <Field label="Post pulse" v={form.post_pulse} type="number"
            on={(v) => setF("post_pulse", v)} />
          <Field label="Urea pre (mg/dL)" v={form.urea_pre_mg_dl} type="number"
            on={(v) => setF("urea_pre_mg_dl", v)} />
          <Field label="Urea post (mg/dL)" v={form.urea_post_mg_dl} type="number"
            on={(v) => setF("urea_post_mg_dl", v)} />
        </div>

        <div className="space-y-1 text-sm">
          <Check label="Intra-dialytic hypotension"
            v={form.intra_dialytic_hypotension}
            on={(v) => setF("intra_dialytic_hypotension", v)} />
          <Check label="Cramps" v={form.cramps} on={(v) => setF("cramps", v)} />
          <Check label="Bleeding" v={form.bleeding} on={(v) => setF("bleeding", v)} />
          <Check label="Clotting" v={form.clotting} on={(v) => setF("clotting", v)} />
          <Check label="Early termination" v={form.early_termination}
            on={(v) => setF("early_termination", v)} />
        </div>

        {form.early_termination && (
          <Field label="Early termination reason" v={form.early_termination_reason}
            on={(v) => setF("early_termination_reason", v)} />
        )}

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Notes
          </label>
          <textarea rows={2} value={form.notes}
            onChange={(e) => setF("notes", e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Completing…" : "Complete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReuseRegisterModal({
  session, onClose, onSaved,
}: { session: SessionRow; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    dialyzer_serial: session.dialyser || "",
    reuse_cycle_count: session.reuse_count != null ? String(session.reuse_count) : "",
    integrity_test_result: "pass",
    integrity_test_method: "",
    disinfectant: "",
    status: "in_use",
    discard_reason: "",
    notes: "",
  });

  const setF = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/dialysis/sessions/${session.id}/reuse-register`,
      {
        method: "POST",
        body: {
          ...form,
          reuse_cycle_count: Number(form.reuse_cycle_count),
          integrity_test_method: form.integrity_test_method || undefined,
          disinfectant: form.disinfectant || undefined,
          discard_reason: form.discard_reason || undefined,
          notes: form.notes || undefined,
        },
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Dialyzer reuse register</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>x</button>
        </div>
        <p className="text-xs text-amber-300">
          Format pending until the authoritative dialyzer reuse register is sourced.
        </p>

        <Field label="Dialyzer serial *" v={form.dialyzer_serial}
          on={(v) => setF("dialyzer_serial", v)} />
        <Field label="Reuse cycle count *" v={form.reuse_cycle_count} type="number"
          on={(v) => setF("reuse_cycle_count", v)} />

        <div className="grid grid-cols-2 gap-2">
          <SelectF label="Integrity test" v={form.integrity_test_result}
            on={(v) => setF("integrity_test_result", v)}
            options={[["pending", "Pending"], ["pass", "Pass"], ["fail", "Fail"], ["not_done", "Not done"]]} />
          <SelectF label="Status" v={form.status}
            on={(v) => setF("status", v)}
            options={[["in_use", "In use"], ["quarantined", "Quarantined"], ["discarded", "Discarded"]]} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Test method" v={form.integrity_test_method}
            on={(v) => setF("integrity_test_method", v)} />
          <Field label="Disinfectant" v={form.disinfectant}
            on={(v) => setF("disinfectant", v)} />
        </div>

        {form.status === "discarded" && (
          <Field label="Discard reason" v={form.discard_reason}
            on={(v) => setF("discard_reason", v)} />
        )}

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Notes
          </label>
          <textarea rows={2} value={form.notes}
            onChange={(e) => setF("notes", e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!form.dialyzer_serial.trim() || !form.reuse_cycle_count || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MachineQaModal({
  session, onClose, onSaved,
}: { session: SessionRow; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    machine_no: session.machine_no || "",
    disinfection_completed: true,
    disinfection_method: "",
    disinfectant_lot: "",
    machine_ready: true,
    status: "passed",
    issues: "",
    notes: "",
  });

  const setF = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      "/dialysis/machine-qa",
      {
        method: "POST",
        body: {
          session_id: session.id,
          machine_no: form.machine_no,
          disinfection_completed: form.disinfection_completed,
          disinfection_method: form.disinfection_method || undefined,
          disinfectant_lot: form.disinfectant_lot || undefined,
          machine_ready: form.machine_ready,
          status: form.status,
          issues: form.issues
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          notes: form.notes || undefined,
        },
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Machine QA</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>x</button>
        </div>

        <Field label="Machine no. *" v={form.machine_no}
          on={(v) => setF("machine_no", v)} />

        <div className="grid grid-cols-2 gap-2">
          <Field label="Disinfection method" v={form.disinfection_method}
            on={(v) => setF("disinfection_method", v)} />
          <Field label="Disinfectant lot" v={form.disinfectant_lot}
            on={(v) => setF("disinfectant_lot", v)} />
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <Check label="Disinfection complete" v={form.disinfection_completed}
            on={(v) => setF("disinfection_completed", v)} />
          <Check label="Machine ready" v={form.machine_ready}
            on={(v) => setF("machine_ready", v)} />
        </div>

        <SelectF label="Status" v={form.status}
          on={(v) => setF("status", v)}
          options={[["pending", "Pending"], ["passed", "Passed"], ["failed", "Failed"], ["maintenance_required", "Maintenance required"]]} />

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Issues
          </label>
          <textarea rows={3} value={form.issues}
            onChange={(e) => setF("issues", e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Notes
          </label>
          <textarea rows={2} value={form.notes}
            onChange={(e) => setF("notes", e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!form.machine_no.trim() || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NumF({
  label, v, on, step,
}: { label: string; v: string | undefined; on: (v: string) => void; step?: string }) {
  return (
    <label className="text-xs">
      <span className="block text-muted-foreground mb-0.5">{label}</span>
      <input type="number" step={step} value={v ?? ""}
        onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm" />
    </label>
  );
}

function Field({
  label, v, on, type = "text", placeholder,
}: {
  label: string; v: string; on: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      <input type={type} value={v} onChange={(e) => on(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
    </div>
  );
}

function SelectF({
  label, v, on, options,
}: { label: string; v: string; on: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      <select value={v} onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
        {options.map(([value, text]) => (
          <option key={value} value={value}>{text}</option>
        ))}
      </select>
    </div>
  );
}

function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
