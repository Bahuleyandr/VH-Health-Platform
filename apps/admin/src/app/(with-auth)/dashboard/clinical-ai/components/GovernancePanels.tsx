"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertOctagon, BookOpen, CheckCircle2, Clock, FileText, Globe2, HeartPulse, Inbox, PlayCircle, Search, Shield, XCircle } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  activateClinicalAiPrompt,
  createClinicalAiPrompt,
  decideClinicalAiApproval,
  endBreakGlassSession,
  getActiveBreakGlassSessions,
  getClinicalAiApprovals,
  getClinicalAiPrompts,
  getClinicalAiReviews,
  getClinicalAiTranslations,
  getCorpusHealth,
  getDeadLetterQueue,
  getLongitudinalRiskOverview,
  listSelfHealingRuns,
  reindexCorpus,
  runSelfHealingScan,
  startBreakGlassSession,
  testCorpusQuery,
  updateClinicalAiReview,
  type ClinicalAiApproval,
  type ClinicalAiBreakGlassSession,
  type ClinicalAiPrompt,
  type ClinicalAiReview,
  type CorpusRetrievalRow,
  type DeadLetterRow,
  type LongitudinalRiskSnapshot,
  type RiskBand,
  type SelfHealingFinding,
  type SelfHealingRun,
  type TranslationRow,
} from "@/lib/api/clinicalAiModules";
import { approvalDetailLines } from "../approvalDetails";

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

function decisionClass(decision: string) {
  const d = decision.toLowerCase();
  if (d === "accepted" || d === "approved" || d === "signed") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (d === "rejected") return "bg-red-100 text-red-800 border-red-200";
  if (d === "needs_revision" || d === "edited") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

// ---------------------------------------------------------------------------
// Break-Glass banner: visible whenever an emergency governance session is live.
// Separate component so the dashboard header can render it above all sections.
// ---------------------------------------------------------------------------
export function BreakGlassBanner() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ["clinical-ai", "break-glass"],
    queryFn: () => getActiveBreakGlassSessions(),
    refetchInterval: 60_000,
  });
  const endSession = useMutation({
    mutationFn: (sessionId: number) => endBreakGlassSession(sessionId),
    onSuccess: () => {
      toast.success("Break-glass session ended");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "break-glass"] });
    },
    onError: (err: Error) => toast.error(err.message || "Could not end session"),
  });

  const activeSessions = sessions.data?.sessions ?? [];
  if (activeSessions.length === 0) return null;

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertOctagon className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
          <div>
            <div className="font-semibold text-red-900">
              Break-Glass active: {activeSessions.length} emergency governance session(s) in effect
            </div>
            <ul className="mt-2 space-y-1 text-sm text-red-900">
              {activeSessions.map((session) => (
                <li key={session.id} className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  <span className="font-medium">{session.scope}</span>
                  <span className="text-red-800">— {session.reason}</span>
                  <span className="text-xs text-red-700">expires {fmt(session.expires_at)}</span>
                  <button
                    onClick={() => endSession.mutate(session.id)}
                    disabled={endSession.isPending}
                    className="ml-2 rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                  >
                    End
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review Queue — drafts that require clinician/coder/quality sign-off.
// ---------------------------------------------------------------------------
const REVIEWER_ROLE_OPTIONS = [
  { value: "", label: "All roles" },
  { value: "DOCTOR", label: "Doctor" },
  { value: "NURSING_STAFF", label: "Nursing staff" },
  { value: "MEDICAL_RECORDS", label: "Medical records" },
  { value: "BILLING_STAFF", label: "Billing" },
  { value: "PHARMACY_STAFF", label: "Pharmacy" },
  { value: "QUALITY_STAFF", label: "Quality" },
  { value: "ADMIN", label: "Admin" },
];

export function ReviewQueuePanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [roleFilter, setRoleFilter] = useState("");

  const reviews = useQuery({
    queryKey: ["clinical-ai", "reviews", decisionFilter, roleFilter],
    queryFn: () =>
      getClinicalAiReviews({
        ...(decisionFilter ? { decision: decisionFilter } : {}),
        ...(roleFilter ? { reviewerRole: roleFilter } : {}),
      }),
  });

  const updateReview = useMutation({
    mutationFn: (payload: { id: number; decision: string; rejection_reason?: string }) =>
      updateClinicalAiReview(payload.id, {
        decision: payload.decision,
        rejection_reason: payload.rejection_reason,
      }),
    onSuccess: (_data, variables) => {
      toast.success(`Review ${variables.decision}`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "generations"] });
    },
    onError: (err: Error) => toast.error(err.message || "Review update failed"),
  });

  const rows: ClinicalAiReview[] = reviews.data?.reviews ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Review Queue</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="needs_revision">Needs Revision</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="">All</option>
          </select>
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            title="Show only reviews for modules whose sign-off roles include this role"
          >
            {REVIEWER_ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Decision</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reviewer</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No reviews in this bucket
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.module_key}</div>
                    <div className="text-xs text-muted-foreground">Gen #{row.generation_id ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid ?? ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${decisionClass(row.decision)}`}>
                      {row.decision}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.reviewer_role ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => updateReview.mutate({ id: row.id, decision: "accepted" })}
                          disabled={updateReview.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => {
                            const reason = window.prompt("Rejection reason (required)");
                            if (!reason) return;
                            updateReview.mutate({
                              id: row.id,
                              decision: "rejected",
                              rejection_reason: reason,
                            });
                          }}
                          disabled={updateReview.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Prompt Registry — draft/create/activate module prompts with version history.
// Activating a prompt opens a two-person approval request.
// ---------------------------------------------------------------------------
function diffLines(before: string, after: string) {
  // Minimal line-level diff. Not a full Myers diff — good enough to spot
  // material changes before activating a prompt.
  const beforeLines = String(before || "").split(/\r?\n/);
  const afterLines = String(after || "").split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const rows: Array<{ kind: "same" | "removed" | "added"; left: string | null; right: string | null }> = [];
  for (let i = 0; i < max; i += 1) {
    const left = i < beforeLines.length ? beforeLines[i] : null;
    const right = i < afterLines.length ? afterLines[i] : null;
    if (left === right) rows.push({ kind: "same", left, right });
    else {
      if (left !== null) rows.push({ kind: "removed", left, right: null });
      if (right !== null) rows.push({ kind: "added", left: null, right });
    }
  }
  return rows;
}

function PromptDiffModal({
  candidate,
  activePrompt,
  onClose,
  onConfirm,
  confirming,
}: {
  candidate: ClinicalAiPrompt;
  activePrompt: ClinicalAiPrompt | null;
  onClose: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const systemDiff = diffLines(activePrompt?.system_prompt ?? "", candidate.system_prompt);
  const userDiff = diffLines(activePrompt?.user_prompt_template ?? "", candidate.user_prompt_template);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">
              Review prompt activation: {candidate.module_key} / {candidate.version}
            </div>
            <div className="text-xs text-muted-foreground">
              {activePrompt ? `Currently active: ${activePrompt.version}` : "No currently active version"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            Close
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">System prompt</div>
          <div className="mb-4 overflow-x-auto rounded-md border border-border font-mono text-xs">
            {systemDiff.map((row, idx) => (
              <div
                key={`sys-${idx}`}
                className={
                  row.kind === "added" ? "bg-emerald-50 text-emerald-900"
                  : row.kind === "removed" ? "bg-red-50 text-red-900 line-through"
                  : ""
                }
              >
                <span className="inline-block w-8 select-none px-2 text-muted-foreground">
                  {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap">{row.right ?? row.left ?? ""}</span>
              </div>
            ))}
          </div>
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">User prompt template</div>
          <div className="overflow-x-auto rounded-md border border-border font-mono text-xs">
            {userDiff.map((row, idx) => (
              <div
                key={`usr-${idx}`}
                className={
                  row.kind === "added" ? "bg-emerald-50 text-emerald-900"
                  : row.kind === "removed" ? "bg-red-50 text-red-900 line-through"
                  : ""
                }
              >
                <span className="inline-block w-8 select-none px-2 text-muted-foreground">
                  {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                </span>
                <span className="whitespace-pre-wrap">{row.right ?? row.left ?? ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            disabled={confirming}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Request Activation
          </button>
        </div>
      </div>
    </div>
  );
}

export function PromptRegistryPanel({ modules }: { modules: { module_key: string; display_name: string }[] }) {
  const queryClient = useQueryClient();
  const [moduleKey, setModuleKey] = useState<string>(modules[0]?.module_key ?? "");
  const [showCreate, setShowCreate] = useState(false);
  const [diffTarget, setDiffTarget] = useState<ClinicalAiPrompt | null>(null);
  const [draft, setDraft] = useState({
    version: "",
    title: "",
    system_prompt: "",
    user_prompt_template: "",
  });

  const prompts = useQuery({
    queryKey: ["clinical-ai", "prompts", moduleKey],
    queryFn: () => getClinicalAiPrompts({ moduleKey: moduleKey || undefined }),
    enabled: Boolean(moduleKey),
  });

  const createPrompt = useMutation({
    mutationFn: () =>
      createClinicalAiPrompt({
        module_key: moduleKey,
        version: draft.version || undefined,
        title: draft.title || undefined,
        system_prompt: draft.system_prompt,
        user_prompt_template: draft.user_prompt_template,
      }),
    onSuccess: () => {
      toast.success("Prompt draft created");
      setShowCreate(false);
      setDraft({ version: "", title: "", system_prompt: "", user_prompt_template: "" });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prompts"] });
    },
    onError: (err: Error) => toast.error(err.message || "Create failed"),
  });

  const activate = useMutation({
    mutationFn: (promptId: number) => activateClinicalAiPrompt(promptId),
    onSuccess: (result) => {
      if (result.approval_required) {
        toast.success("Approval requested — second admin must approve");
      } else {
        toast.success("Prompt activated");
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prompts"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "approvals"] });
    },
    onError: (err: Error) => toast.error(err.message || "Activate failed"),
  });

  const rows: ClinicalAiPrompt[] = prompts.data?.prompts ?? [];
  const activePrompt = rows.find((row) => row.active) ?? null;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Prompt Registry</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={moduleKey}
            onChange={(event) => setModuleKey(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            {modules.map((module) => (
              <option key={module.module_key} value={module.module_key}>
                {module.display_name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCreate((current) => !current)}
            className="rounded-md border border-border bg-card px-3 py-1 text-sm font-medium hover:bg-accent"
          >
            {showCreate ? "Cancel" : "+ New Version"}
          </button>
        </div>
      </div>

      {activePrompt ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <div className="font-medium text-emerald-900">
            Active: {activePrompt.version}{activePrompt.title ? ` — ${activePrompt.title}` : ""}
          </div>
          <div className="text-xs text-emerald-800">Activated {fmt(activePrompt.activated_at)}</div>
        </div>
      ) : null}

      {showCreate ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs text-muted-foreground">
              Version
              <input
                value={draft.version}
                onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                placeholder="v2"
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Title
              <input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="Descriptive title"
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
              />
            </label>
          </div>
          <label className="block text-xs text-muted-foreground">
            System prompt
            <textarea
              value={draft.system_prompt}
              onChange={(event) => setDraft({ ...draft, system_prompt: event.target.value })}
              rows={4}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm font-mono"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            User prompt template
            <textarea
              value={draft.user_prompt_template}
              onChange={(event) => setDraft({ ...draft, user_prompt_template: event.target.value })}
              rows={3}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm font-mono"
            />
          </label>
          <div className="flex justify-end">
            <button
              onClick={() => createPrompt.mutate()}
              disabled={!draft.system_prompt || createPrompt.isPending}
              className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save Draft
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Version</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Title</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No prompts defined for this module
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono">{row.version}</td>
                  <td className="px-4 py-3">{row.title ?? "-"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.active ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {row.status}{row.active ? " (live)" : ""}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.active ? (
                      <span className="text-xs text-muted-foreground">in use</span>
                    ) : (
                      <button
                        onClick={() => setDiffTarget(row)}
                        disabled={activate.isPending}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        View Diff & Request
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {diffTarget ? (
        <PromptDiffModal
          candidate={diffTarget}
          activePrompt={activePrompt}
          onClose={() => setDiffTarget(null)}
          onConfirm={() => {
            const target = diffTarget;
            setDiffTarget(null);
            activate.mutate(target.id);
          }}
          confirming={activate.isPending}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Approvals — two-person queue for prompt activation + high-risk governance.
// Current admin cannot approve their own request.
// ---------------------------------------------------------------------------
export function ApprovalsPanel({ currentAdminUid }: { currentAdminUid: string | null }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending");

  const approvals = useQuery({
    queryKey: ["clinical-ai", "approvals", statusFilter],
    queryFn: () => getClinicalAiApprovals(statusFilter ? { status: statusFilter } : {}),
  });

  const decide = useMutation({
    mutationFn: (payload: { id: number; decision: "approved" | "rejected"; reason?: string }) =>
      decideClinicalAiApproval(payload.id, payload.decision, payload.reason),
    onSuccess: (_data, variables) => {
      toast.success(`Approval ${variables.decision}`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "approvals"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prompts"] });
    },
    onError: (err: Error) => toast.error(err.message || "Approval update failed"),
  });

  const rows: ClinicalAiApproval[] = approvals.data?.approvals ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Approvals</h2>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Type</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Requested</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No approvals in this bucket
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isOwnRequest =
                  Boolean(currentAdminUid) && row.requested_by === currentAdminUid;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-mono text-xs">{row.approval_type}</td>
                    <td className="px-4 py-3">{row.module_key ?? "-"}</td>
                    <td className="px-4 py-3">
                      <div>{row.reason ?? "-"}</div>
                      {approvalDetailLines(row).length ? (
                        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {approvalDetailLines(row).map((line) => (
                            <div key={line}>{line}</div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${decisionClass(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                    <td className="px-4 py-3 text-right">
                      {row.status === "pending" ? (
                        <div className="inline-flex gap-1">
                          <button
                            onClick={() =>
                              decide.mutate({ id: row.id, decision: "approved" })
                            }
                            disabled={decide.isPending || isOwnRequest}
                            title={isOwnRequest ? "Two-person approval required — another admin must approve your request" : undefined}
                            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => {
                              const reason = window.prompt("Rejection reason (optional)") ?? undefined;
                              decide.mutate({ id: row.id, decision: "rejected", reason });
                            }}
                            disabled={decide.isPending}
                            className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Break-Glass control — start/end emergency governance sessions.
// ---------------------------------------------------------------------------
export function BreakGlassControls() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState("clinical_ai");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("2");

  const sessions = useQuery({
    queryKey: ["clinical-ai", "break-glass"],
    queryFn: () => getActiveBreakGlassSessions(),
  });

  const start = useMutation({
    mutationFn: () =>
      startBreakGlassSession({
        scope,
        reason,
        expires_in_hours: Number.parseInt(hours, 10) || 2,
      }),
    onSuccess: () => {
      toast.success("Break-glass session opened");
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "break-glass"] });
    },
    onError: (err: Error) => toast.error(err.message || "Could not start session"),
  });

  const end = useMutation({
    mutationFn: (sessionId: number) => endBreakGlassSession(sessionId),
    onSuccess: () => {
      toast.success("Session ended");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "break-glass"] });
    },
    onError: (err: Error) => toast.error(err.message || "Could not end session"),
  });

  const rows: ClinicalAiBreakGlassSession[] = sessions.data?.sessions ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <XCircle className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Break-Glass Sessions</h2>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-muted-foreground">
            Scope
            <input
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground md:col-span-2">
            Reason
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this required right now?"
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Expires in (hours)
            <input
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              type="number"
              min={1}
              max={24}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => start.mutate()}
            disabled={!reason || start.isPending}
            className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
          >
            Open Session
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scope</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Expires</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={4}>
                  No active sessions
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.scope}</td>
                  <td className="px-4 py-3">{row.reason}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.expires_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => end.mutate(row.id)}
                      disabled={end.isPending}
                      className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                    >
                      End
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Self-Healing — read-only agent that surfaces operational risks as findings.
// Never mutates production; each run persists a structured audit row.
// ---------------------------------------------------------------------------
function severityBadgeClass(severity: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

export function SelfHealingPanel() {
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ["clinical-ai", "self-healing", "runs"],
    queryFn: () => listSelfHealingRuns(),
  });

  const run = useMutation({
    mutationFn: () => runSelfHealingScan("manual"),
    onSuccess: (result) => {
      const findingCount = result.findings.length;
      toast.success(
        findingCount === 0
          ? "Scan complete — no findings"
          : `Scan complete — ${findingCount} finding${findingCount === 1 ? "" : "s"}`
      );
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "self-healing", "runs"] });
    },
    onError: (err: Error) => toast.error(err.message || "Scan failed"),
  });

  const rows: SelfHealingRun[] = runs.data?.runs ?? [];
  const latestFindings: SelfHealingFinding[] = rows[0]?.findings ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Self-Healing (Read-only)</h2>
        </div>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {run.isPending ? "Scanning…" : "Run Scan"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        This agent only reads. Findings are surfaced as draft suggestions; no production state is modified.
      </p>

      {latestFindings.length > 0 ? (
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Finding</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Suggested Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {latestFindings.map((finding, idx) => (
                <tr key={`${finding.code}-${idx}`}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(finding.severity)}`}>
                      {finding.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-muted-foreground">{finding.code}</div>
                    <div>{finding.message}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{finding.suggested_action ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows.length > 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Latest scan found no issues.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          No scans yet. Run one to inspect fallback rate, stale reviews, break-glass, and process health.
        </div>
      )}

      {rows.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          Last scan: {rows[0].finished_at || rows[0].started_at} ({rows[0].status}) — {rows.length} runs in history.
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// RAG corpus — institutional memory health, reindex trigger, test query.
// Gracefully surfaces "pgvector not installed" state so ops knows to act.
// ---------------------------------------------------------------------------
export function CorpusHealthPanel() {
  const queryClient = useQueryClient();
  const [testQuery, setTestQuery] = useState("");
  const [testResults, setTestResults] = useState<CorpusRetrievalRow[]>([]);
  const [testStatus, setTestStatus] = useState<string>("");

  const health = useQuery({
    queryKey: ["clinical-ai", "corpus"],
    queryFn: () => getCorpusHealth(),
  });

  const reindex = useMutation({
    mutationFn: () => reindexCorpus(200),
    onSuccess: (result) => {
      if (result.halted) {
        toast.error(`Reindex halted: ${result.reason || "unknown"}`);
      } else {
        toast.success(`Reindexed ${result.indexed} chunks (skipped ${result.skipped})`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "corpus"] });
    },
    onError: (err: Error) => toast.error(err.message || "Reindex failed"),
  });

  const probe = useMutation({
    mutationFn: (query: string) =>
      testCorpusQuery({
        query,
        source_type: "discharge_summary",
        top_k: 5,
        min_score: 0.5,
      }),
    onSuccess: (result) => {
      setTestResults(result.results || []);
      setTestStatus(result.source);
    },
    onError: (err: Error) => toast.error(err.message || "Query failed"),
  });

  if (health.data && !health.data.corpus_available) {
    return (
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Institutional Memory (RAG)</h2>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">pgvector not installed on this database.</div>
          <p className="mt-1">
            RAG retrieval is disabled. Drafts continue to generate using the current chart packet only.
            Install <code className="rounded bg-amber-100 px-1 text-xs">pgvector</code> and re-run migration
            <code className="rounded bg-amber-100 px-1 text-xs">015_rag_corpus.sql</code> to enable
            institutional memory.
          </p>
        </div>
      </section>
    );
  }

  const rows = health.data?.by_source_type ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Institutional Memory (RAG)</h2>
        </div>
        <button
          onClick={() => reindex.mutate()}
          disabled={reindex.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {reindex.isPending ? "Reindexing…" : "Reindex Signed Documents"}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Total chunks</div>
          <div className="mt-1 text-2xl font-semibold">{health.data?.total_chunks ?? 0}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Source types</div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Expired chunks (past retention)</div>
          <div className="mt-1 text-2xl font-semibold">
            {rows.reduce((sum, row) => sum + Number(row.expired_chunks || 0), 0)}
          </div>
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source type</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Documents</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Chunks</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Oldest signed</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Newest signed</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Expired</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.source_type}>
                  <td className="px-4 py-3 font-mono text-xs">{row.source_type}</td>
                  <td className="px-4 py-3">{row.document_count}</td>
                  <td className="px-4 py-3">{row.chunk_count}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.oldest_signed)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.newest_signed)}</td>
                  <td className="px-4 py-3">{row.expired_chunks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          No chunks indexed yet. Reindex to backfill from signed discharge summaries.
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Search className="h-4 w-4" />
          Test query
        </div>
        <p className="text-xs text-muted-foreground">
          Dry-run a retrieval. Pulls up to 5 similar discharge summaries from this tenant&apos;s corpus.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={testQuery}
            onChange={(event) => setTestQuery(event.target.value)}
            placeholder="e.g. community acquired pneumonia, diabetic ketoacidosis"
            className="flex-1 rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <button
            onClick={() => probe.mutate(testQuery)}
            disabled={!testQuery.trim() || probe.isPending}
            className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {probe.isPending ? "Searching…" : "Search"}
          </button>
        </div>
        {testStatus ? (
          <div className="mt-2 text-xs text-muted-foreground">
            Status: <span className="font-mono">{testStatus}</span>
            {testResults.length > 0 ? ` — ${testResults.length} hit(s)` : ""}
          </div>
        ) : null}
        {testResults.length > 0 ? (
          <ul className="mt-2 space-y-2 text-xs">
            {testResults.map((row) => (
              <li key={row.id} className="rounded border border-border bg-card p-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono">{row.source_type} / {row.source_id}</span>
                  <span className="text-muted-foreground">sim {Number(row.similarity).toFixed(2)}</span>
                </div>
                <p className="mt-1 line-clamp-3 text-muted-foreground">{row.content}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dead-letter queue — drafts blocked by CRITICAL defense flags. Admin
// triage only; never auto-accepted.
// ---------------------------------------------------------------------------
export function DeadLetterPanel() {
  const dead = useQuery({
    queryKey: ["clinical-ai", "dead-letter"],
    queryFn: () => getDeadLetterQueue(),
    refetchInterval: 120_000,
  });

  const rows: DeadLetterRow[] = dead.data?.generations ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Inbox className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Dead-Letter Queue</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Drafts that tripped a critical defense (PHI leak, unsafe allergy, schema fail) are held here.
        They never reach reviewers; a platform admin must investigate and document the root cause.
      </p>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          No blocked drafts.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Blocking flag</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const critical = (row.safety_flags || []).find((f) => f.severity === "critical")
                  ?? row.safety_flags?.[0];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.module_key}</div>
                      <div className="text-xs text-muted-foreground font-mono">gen #{row.id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{row.patient_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.patient_uid ?? ""}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">{row.provider}</td>
                    <td className="px-4 py-3">
                      {critical ? (
                        <>
                          <div className="font-mono text-xs text-red-800">{critical.code}</div>
                          <div className="text-xs text-muted-foreground">{critical.message}</div>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Translations — tenant-wide roll-up of completed + flagged translations.
// Status needs_review flags translations that tripped a fidelity check,
// so ops can triage before the patient-facing surface renders them.
// ---------------------------------------------------------------------------
const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  mr: "Marathi",
  bn: "Bengali",
  kn: "Kannada",
};

function translationStatusClass(status: string) {
  if (status === "completed") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "needs_review") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-red-100 text-red-800 border-red-200";
}

export function TranslationsPanel() {
  const [languageFilter, setLanguageFilter] = useState<string>("");
  const translations = useQuery({
    queryKey: ["clinical-ai", "translations", languageFilter],
    queryFn: () => getClinicalAiTranslations(languageFilter || undefined),
  });

  const rows: TranslationRow[] = translations.data?.translations ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Patient Translations</h2>
        </div>
        <select
          value={languageFilter}
          onChange={(event) => setLanguageFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="">All languages</option>
          {Object.entries(LANGUAGE_LABELS).filter(([code]) => code !== "en").map(([code, label]) => (
            <option key={code} value={code}>{label} ({code})</option>
          ))}
        </select>
      </div>

      <p className="text-xs text-muted-foreground">
        Only reviewer-accepted drafts are translated. Rows marked <strong>needs_review</strong> tripped a
        numeric/date/drug fidelity check and must not be shown to the patient until a clinician reconfirms.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Target</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Fidelity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No translations yet
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.module_key ?? "-"}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      source gen #{row.source_generation_id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium">
                      {LANGUAGE_LABELS[row.target_language] ?? row.target_language}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{row.provider}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${translationStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.fidelity_flags.length === 0 ? (
                      <span className="text-xs text-emerald-700">All tuples preserved</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.fidelity_flags.slice(0, 3).map((flag, idx) => (
                          <li key={idx} className={`text-xs ${flag.severity === "high" ? "text-red-800" : "text-amber-800"}`}>
                            <span className="font-mono">{flag.code}</span>: {flag.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Longitudinal risk overview — tenant-wide roll-up of the most recent
// risk snapshot per admission, banded. Shows only high + critical by
// default so leadership can zero in on the patients who need care-
// manager attention.
// ---------------------------------------------------------------------------
function riskBandClass(band: string) {
  if (band === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (band === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

function scoreColorClass(score: number) {
  if (score >= 85) return "text-red-700";
  if (score >= 60) return "text-orange-700";
  if (score >= 30) return "text-amber-700";
  return "text-emerald-700";
}

export function LongitudinalRiskPanel() {
  const [bandFilter, setBandFilter] = useState<RiskBand | "">("high");
  const snapshots = useQuery({
    queryKey: ["clinical-ai", "longitudinal-risk", bandFilter],
    queryFn: () => getLongitudinalRiskOverview(bandFilter || undefined),
  });

  const rows: LongitudinalRiskSnapshot[] = snapshots.data?.snapshots ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Longitudinal Risk Overview</h2>
        </div>
        <select
          value={bandFilter}
          onChange={(event) => setBandFilter(event.target.value as RiskBand | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="critical">Critical only</option>
          <option value="high">High + critical candidates</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="">All bands</option>
        </select>
      </div>

      <p className="text-xs text-muted-foreground">
        Decision-support only. Each snapshot is immutable; recomputing creates a new snapshot with a new timestamp.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Band</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Contributors</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top recommendation</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No snapshots in this band yet
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const topRec = row.recommendations?.[0];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.patient_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.patient_uid ?? ""}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">#{row.admission_id}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${riskBandClass(row.band)}`}>
                        {row.band}
                      </span>
                    </td>
                    <td className={`px-4 py-3 font-semibold ${scoreColorClass(row.overall_score)}`}>
                      {Number(row.overall_score).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      adh {Number(row.adherence_score ?? 0).toFixed(0)}
                      {" · "}
                      rd {Number(row.readmission_score ?? 0).toFixed(0)}
                      {" · "}
                      cmb {Number(row.comorbidity_score ?? 0).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {topRec ? (
                        <div className="max-w-md">
                          <div className="font-mono text-muted-foreground">{topRec.category}</div>
                          <div>{topRec.message}</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
