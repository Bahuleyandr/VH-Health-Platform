"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, CheckCircle2, Clock, FileText, Shield, XCircle } from "lucide-react";
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
  startBreakGlassSession,
  updateClinicalAiReview,
  type ClinicalAiApproval,
  type ClinicalAiBreakGlassSession,
  type ClinicalAiPrompt,
  type ClinicalAiReview,
} from "@/lib/api/emr";

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
export function ReviewQueuePanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");

  const reviews = useQuery({
    queryKey: ["clinical-ai", "reviews", decisionFilter],
    queryFn: () => getClinicalAiReviews(decisionFilter ? { decision: decisionFilter } : {}),
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
export function PromptRegistryPanel({ modules }: { modules: { module_key: string; display_name: string }[] }) {
  const queryClient = useQueryClient();
  const [moduleKey, setModuleKey] = useState<string>(modules[0]?.module_key ?? "");
  const [showCreate, setShowCreate] = useState(false);
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
                        onClick={() => activate.mutate(row.id)}
                        disabled={activate.isPending}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Request Activation
                      </button>
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
                    <td className="px-4 py-3">{row.reason ?? "-"}</td>
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
