"use client";

/**
 * Phase A2 dedupe + merge admin page.
 *
 * Three sections:
 *   1. "Run dedupe scan" button + last-run summary.
 *   2. Open candidates grouped by confidence band (>=90 critical,
 *      80-89 high, <80 review). Per-row request-merge / mark-not-
 *      duplicate actions.
 *   3. Merge requests with status filter and per-row two-person-rule
 *      actions (approve / reject / cancel / execute). Surfaces
 *      execution_summary.table_summary after a successful execute so
 *      admins can see which tables moved how many rows.
 *
 * Listing + sign-off backed by the unified /api/v1/admin/patient-merges
 * surface; no backend changes here.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon, AlertTriangle, CheckCircle, History, Play, ShieldAlert,
  ShieldCheck, ThumbsDown, Undo2, X,
} from "lucide-react";
import { toast } from "react-hot-toast";

import { useAuth } from "@/contexts/AuthContext";
import {
  approveMergeRequest,
  cancelMergeRequest,
  executeMergeRequest,
  listDuplicateCandidates,
  listMergeRequests,
  rejectDuplicateCandidate,
  rejectMergeRequest,
  requestPatientMerge,
  runDedupeDetect,
  type DedupeRunSummary,
  type DuplicateCandidate,
  type DuplicateCandidateStatus,
  type DuplicateMatchSignal,
  type MergeExecutionSummary,
  type MergeRequestStatus,
  type PatientMergeRequest,
} from "@/lib/api/patientMergeAdmin";

const CANDIDATE_STATUSES: DuplicateCandidateStatus[] = [
  "open", "merged", "rejected_not_duplicate", "expired",
];

const MERGE_STATUSES: MergeRequestStatus[] = [
  "requested", "approved", "executed", "rejected", "cancelled",
];

function fmt(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function shortUid(uid?: string | null) {
  if (!uid) return "-";
  return uid.length > 12 ? `${uid.slice(0, 8)}…${uid.slice(-4)}` : uid;
}

function bandForScore(score: number) {
  if (score >= 90) return { key: "critical", label: "Critical (≥90)", color: "border-red-200 bg-red-50 text-red-900" };
  if (score >= 80) return { key: "high", label: "High (80–89)", color: "border-orange-200 bg-orange-50 text-orange-900" };
  return { key: "review", label: "Review (<80)", color: "border-amber-200 bg-amber-50 text-amber-900" };
}

function statusPillClass(status: string) {
  switch (status) {
    case "executed":
    case "merged":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "approved":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "requested":
    case "open":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "rejected":
    case "rejected_not_duplicate":
      return "border-red-200 bg-red-50 text-red-800";
    case "cancelled":
    case "expired":
      return "border-slate-200 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function asMatchSignals(value: DuplicateCandidate["match_signals"]): DuplicateMatchSignal[] {
  if (Array.isArray(value)) return value as DuplicateMatchSignal[];
  return [];
}

export default function PatientDedupePage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const currentUid = user?.uid ?? null;

  const [candidateStatus, setCandidateStatus] = useState<DuplicateCandidateStatus>("open");
  const [mergeStatus, setMergeStatus] = useState<MergeRequestStatus | "all">("requested");
  const [lastRun, setLastRun] = useState<DedupeRunSummary | null>(null);

  const candidatesQuery = useQuery({
    queryKey: ["patient-dedupe", "candidates", candidateStatus],
    queryFn: () => listDuplicateCandidates({ status: candidateStatus, limit: 100 }),
  });

  const mergesQuery = useQuery({
    queryKey: ["patient-dedupe", "merges", mergeStatus],
    queryFn: () => listMergeRequests(
      mergeStatus === "all" ? { limit: 100 } : { status: mergeStatus, limit: 100 },
    ),
  });

  const candidates = useMemo(
    () => candidatesQuery.data?.candidates ?? [],
    [candidatesQuery.data?.candidates],
  );
  const merges = useMemo(
    () => mergesQuery.data?.merge_requests ?? [],
    [mergesQuery.data?.merge_requests],
  );

  const detect = useMutation({
    mutationFn: () => runDedupeDetect({ limit: 500 }),
    onSuccess: (run) => {
      setLastRun(run);
      if (run.halted) {
        toast.error(`Dedupe halted: ${run.reason ?? "unknown"}`);
      } else {
        const inserted = run.candidates_inserted ?? 0;
        const scanned = run.scanned_pairs ?? 0;
        toast.success(`Scanned ${scanned} pair${scanned === 1 ? "" : "s"}; ${inserted} new / refreshed candidate${inserted === 1 ? "" : "s"}.`);
      }
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "candidates"] });
    },
    onError: (err: Error) => toast.error(err.message || "Dedupe scan failed"),
  });

  const rejectCandidate = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string | null }) =>
      rejectDuplicateCandidate(id, { decision_note: note }),
    onSuccess: () => {
      toast.success("Candidate marked not-a-duplicate");
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "candidates"] });
    },
    onError: (err: Error) => toast.error(err.message || "Mark-not-duplicate failed"),
  });

  const requestMerge = useMutation({
    mutationFn: ({ candidate, note }: { candidate: DuplicateCandidate; note: string | null }) =>
      requestPatientMerge({
        primary_uid: candidate.primary_uid,
        secondary_uid: candidate.secondary_uid,
        candidate_id: candidate.id,
        requester_note: note,
      }),
    onSuccess: () => {
      toast.success("Merge requested. An approver other than you must sign off.");
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "candidates"] });
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "merges"] });
      setMergeStatus("requested");
    },
    onError: (err: Error) => toast.error(err.message || "Merge request failed"),
  });

  const approve = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string | null }) =>
      approveMergeRequest(id, { approver_note: note }),
    onSuccess: () => {
      toast.success("Merge approved — ready to execute.");
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "merges"] });
    },
    onError: (err: Error) => toast.error(err.message || "Approval failed"),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string | null }) =>
      rejectMergeRequest(id, { rejection_reason: reason }),
    onSuccess: () => {
      toast.success("Merge rejected");
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "merges"] });
    },
    onError: (err: Error) => toast.error(err.message || "Reject failed"),
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string | null }) =>
      cancelMergeRequest(id, { reason }),
    onSuccess: () => {
      toast.success("Merge cancelled");
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "merges"] });
    },
    onError: (err: Error) => toast.error(err.message || "Cancel failed"),
  });

  const execute = useMutation({
    mutationFn: (id: number) => executeMergeRequest(id),
    onSuccess: (row) => {
      const moved = row.execution_summary?.total_rows_moved ?? 0;
      toast.success(`Merge executed — ${moved} row${moved === 1 ? "" : "s"} moved.`);
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "merges"] });
      queryClient.invalidateQueries({ queryKey: ["patient-dedupe", "candidates"] });
    },
    onError: (err: Error) => toast.error(err.message || "Execute failed"),
  });

  const grouped = useMemo(() => {
    const buckets: Record<string, DuplicateCandidate[]> = { critical: [], high: [], review: [] };
    for (const c of candidates) {
      buckets[bandForScore(Number(c.confidence_score)).key].push(c);
    }
    return buckets;
  }, [candidates]);

  return (
    <div className="space-y-6 p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Patient dedupe & merge</h1>
          <p className="text-xs text-muted-foreground">
            Backed by /api/v1/admin/patient-merges. Two-person rule enforced — the requester cannot approve their own merge.
          </p>
        </div>
        <button
          type="button"
          onClick={() => detect.mutate()}
          disabled={detect.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {detect.isPending ? "Scanning…" : "Run dedupe scan"}
        </button>
      </header>

      {lastRun ? (
        <div className="rounded-md border border-border bg-card p-3 text-xs">
          <p className="font-semibold">
            Last run · {lastRun.run_id ? <span className="font-mono">{lastRun.run_id}</span> : "—"}
          </p>
          <p className="text-muted-foreground">
            Scanned {lastRun.scanned_pairs ?? 0} pair{lastRun.scanned_pairs === 1 ? "" : "s"} ·{" "}
            inserted/refreshed {lastRun.candidates_inserted ?? 0} ·{" "}
            skipped {lastRun.candidates_skipped ?? 0}
            {lastRun.halted ? <span className="ml-2 text-red-700">halted: {lastRun.reason}</span> : null}
          </p>
        </div>
      ) : null}

      <CandidatesSection
        status={candidateStatus}
        onStatusChange={setCandidateStatus}
        loading={candidatesQuery.isLoading}
        grouped={grouped}
        onReject={(c) => {
          const note = window.prompt(`Reason for marking ${shortUid(c.primary_uid)} ↔ ${shortUid(c.secondary_uid)} as NOT a duplicate?`, "");
          if (note == null) return;
          rejectCandidate.mutate({ id: c.id, note: note.trim() || null });
        }}
        onRequestMerge={(c) => {
          const note = window.prompt(`Optional note for the approver about merging ${shortUid(c.primary_uid)} ← ${shortUid(c.secondary_uid)}:`, "");
          if (note == null) return;
          requestMerge.mutate({ candidate: c, note: note.trim() || null });
        }}
        actionsBusy={rejectCandidate.isPending || requestMerge.isPending}
      />

      <MergeRequestsSection
        status={mergeStatus}
        onStatusChange={setMergeStatus}
        loading={mergesQuery.isLoading}
        rows={merges}
        currentUid={currentUid}
        onApprove={(row) => {
          if (currentUid && row.requested_by && currentUid === row.requested_by) {
            toast.error("Two-person rule: you requested this merge — a different admin must approve.");
            return;
          }
          const note = window.prompt(`Approve merge ${shortUid(row.primary_uid)} ← ${shortUid(row.secondary_uid)}? Optional note:`, "");
          if (note == null) return;
          approve.mutate({ id: row.id, note: note.trim() || null });
        }}
        onReject={(row) => {
          const reason = window.prompt(`Reject merge ${shortUid(row.primary_uid)} ← ${shortUid(row.secondary_uid)}? Reason:`, "");
          if (reason == null) return;
          reject.mutate({ id: row.id, reason: reason.trim() || null });
        }}
        onCancel={(row) => {
          const reason = window.prompt(`Cancel merge request ${row.id}? Optional reason:`, "");
          if (reason == null) return;
          cancel.mutate({ id: row.id, reason: reason.trim() || null });
        }}
        onExecute={(row) => {
          if (!window.confirm(`Execute merge ${row.id}? This sweeps every patient FK row from secondary → primary and is one-way.`)) return;
          execute.mutate(row.id);
        }}
        actionsBusy={
          approve.isPending || reject.isPending || cancel.isPending || execute.isPending
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candidates section
// ---------------------------------------------------------------------------
function CandidatesSection({
  status, onStatusChange, loading, grouped, onReject, onRequestMerge, actionsBusy,
}: {
  status: DuplicateCandidateStatus;
  onStatusChange: (s: DuplicateCandidateStatus) => void;
  loading: boolean;
  grouped: Record<string, DuplicateCandidate[]>;
  onReject: (c: DuplicateCandidate) => void;
  onRequestMerge: (c: DuplicateCandidate) => void;
  actionsBusy: boolean;
}) {
  const total = grouped.critical.length + grouped.high.length + grouped.review.length;
  const bands: Array<{ key: "critical" | "high" | "review"; icon: typeof AlertOctagon }> = [
    { key: "critical", icon: AlertOctagon },
    { key: "high", icon: AlertTriangle },
    { key: "review", icon: ShieldAlert },
  ];

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold">Duplicate candidates</h2>
        <div className="flex items-center gap-1">
          {CANDIDATE_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onStatusChange(value)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                status === value
                  ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                  : "border-border bg-card hover:bg-accent"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading candidates…</p>
      ) : total === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No {status} candidates. Try running a fresh scan.
        </p>
      ) : (
        <div className="space-y-3">
          {bands.map(({ key, icon: Icon }) => {
            const rows = grouped[key];
            if (!rows.length) return null;
            const band = bandForScore(key === "critical" ? 95 : key === "high" ? 85 : 70);
            return (
              <div key={key} className={`rounded-md border p-2 ${band.color}`}>
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <Icon className="h-4 w-4" />
                  {band.label} · {rows.length}
                </p>
                <div className="overflow-x-auto rounded border border-border bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Primary</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Secondary</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Score</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Signals</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Detected</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.slice(0, 50).map((row) => (
                        <tr key={row.id}>
                          <td className="px-3 py-1.5 font-mono text-foreground">{shortUid(row.primary_uid)}</td>
                          <td className="px-3 py-1.5 font-mono text-foreground">{shortUid(row.secondary_uid)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{Number(row.confidence_score).toFixed(0)}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {asMatchSignals(row.match_signals).slice(0, 6).map((s, idx) => (
                                <span
                                  key={`${s.identifier_type}-${idx}`}
                                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-wide"
                                >
                                  {s.identifier_type}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.created_at)}</td>
                          <td className="px-3 py-1.5 space-x-1 text-right">
                            <button
                              type="button"
                              onClick={() => onRequestMerge(row)}
                              disabled={actionsBusy || status !== "open"}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                            >
                              <ShieldCheck className="h-3 w-3" />
                              Request merge
                            </button>
                            <button
                              type="button"
                              onClick={() => onReject(row)}
                              disabled={actionsBusy || status !== "open"}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                            >
                              <ThumbsDown className="h-3 w-3" />
                              Not a duplicate
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Merge requests section
// ---------------------------------------------------------------------------
function MergeRequestsSection({
  status, onStatusChange, loading, rows, currentUid,
  onApprove, onReject, onCancel, onExecute, actionsBusy,
}: {
  status: MergeRequestStatus | "all";
  onStatusChange: (s: MergeRequestStatus | "all") => void;
  loading: boolean;
  rows: PatientMergeRequest[];
  currentUid: string | null;
  onApprove: (row: PatientMergeRequest) => void;
  onReject: (row: PatientMergeRequest) => void;
  onCancel: (row: PatientMergeRequest) => void;
  onExecute: (row: PatientMergeRequest) => void;
  actionsBusy: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4 text-muted-foreground" />
          Merge requests
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          {(["all", ...MERGE_STATUSES] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onStatusChange(value)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                status === value
                  ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                  : "border-border bg-card hover:bg-accent"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading merge requests…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No merge requests in {status} status.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const isOwnRequest = currentUid != null && row.requested_by != null && currentUid === row.requested_by;
            return (
              <div key={row.id} className="rounded-md border border-border bg-card p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 font-medium ${statusPillClass(row.status)}`}>
                    {row.status}
                  </span>
                  <span className="font-mono text-muted-foreground">#{row.id}</span>
                  <span className="text-foreground">
                    {shortUid(row.primary_uid)} ← {shortUid(row.secondary_uid)}
                  </span>
                  <span className="text-muted-foreground">requested {fmt(row.requested_at)}</span>
                  {isOwnRequest ? (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800">
                      you requested — cannot approve
                    </span>
                  ) : null}
                </div>
                {row.requester_note ? (
                  <p className="mt-1 text-muted-foreground">
                    requester note: <span className="text-foreground">{row.requester_note}</span>
                  </p>
                ) : null}
                {row.approver_note ? (
                  <p className="mt-1 text-muted-foreground">
                    approver note: <span className="text-foreground">{row.approver_note}</span>
                  </p>
                ) : null}
                {row.rejection_reason ? (
                  <p className="mt-1 text-red-700">rejection: {row.rejection_reason}</p>
                ) : null}
                {row.execution_summary ? (
                  <ExecutionSummary summary={row.execution_summary} />
                ) : null}

                <div className="mt-2 flex flex-wrap gap-1">
                  {row.status === "requested" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onApprove(row)}
                        disabled={actionsBusy || isOwnRequest}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <CheckCircle className="h-3 w-3" />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => onReject(row)}
                        disabled={actionsBusy}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancel(row)}
                        disabled={actionsBusy}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        <Undo2 className="h-3 w-3" />
                        Cancel
                      </button>
                    </>
                  ) : null}
                  {row.status === "approved" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onExecute(row)}
                        disabled={actionsBusy}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        Execute (one-way)
                      </button>
                      <button
                        type="button"
                        onClick={() => onCancel(row)}
                        disabled={actionsBusy}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        <Undo2 className="h-3 w-3" />
                        Cancel
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ExecutionSummary({ summary }: { summary: MergeExecutionSummary }) {
  const tableRows = Object.entries(summary.table_summary || {});
  return (
    <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 text-xs">
      <p className="mb-1 font-semibold">
        Execution summary · {summary.identifiers_reassigned} identifier
        {summary.identifiers_reassigned === 1 ? "" : "s"} + {summary.total_rows_moved - summary.identifiers_reassigned} row
        {summary.total_rows_moved - summary.identifiers_reassigned === 1 ? "" : "s"} moved
      </p>
      {tableRows.length ? (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.65rem]">
          {tableRows.map(([table, info]) => (
            <li key={table} className="flex items-center justify-between">
              <span className="font-mono">{table}</span>
              <span className="text-muted-foreground">
                {info.skipped ? `skipped (${info.skipped})` : `${info.rows_moved ?? 0}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
