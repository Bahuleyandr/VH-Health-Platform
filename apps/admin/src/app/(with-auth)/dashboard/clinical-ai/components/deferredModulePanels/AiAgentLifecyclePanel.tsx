"use client";

// Phase-2 clinical-AI panel. Tracker row 35 — ai_agent_lifecycle_manager.
// Two-tier module:
//   Top tier  — agent registry (list + upsert form + stage/approval change)
//   Bottom    — agent health reports (record + list + decide via shared queue)
//
// Backend routes (apps/backend/src/routes/admin/clinicalAiRoutes.js):
//   POST  /admin/clinical-ai/agent-registry                         upsertAgentRegistry
//   GET   /admin/clinical-ai/agent-registry                         listAgentRegistry
//   PATCH /admin/clinical-ai/agent-registry/:id/stage               changeAgentStage
//   POST  /admin/clinical-ai/agent-registry/health-reports          recordAgentHealth
//   GET   /admin/clinical-ai/agent-registry/health-reports          listAgentHealthReports
//   PATCH /admin/clinical-ai/agent-registry/health-reports/:id      decideAgentHealthReport
// Service: apps/backend/src/services/ai/aiAgentLifecycleService.js

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, PlayCircle, Save, Workflow } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  evaluateClinicalAi,
  listClinicalAi,
  patchClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Reference data mirrors STAGES / APPROVAL_STATES / RECOMMENDATIONS in
// aiAgentLifecycleService.js.
// ---------------------------------------------------------------------------
const STAGES = [
  "sandbox",
  "staging",
  "production",
  "deprecated",
  "quarantined",
  "unknown",
] as const;

const APPROVAL_STATES = [
  "pending",
  "approved",
  "revoked",
  "rejected",
  "pending_renewal",
] as const;

const RECOMMENDATIONS = [
  "renew",
  "hold",
  "retire",
  "quarantine",
  "no_action",
  "unknown",
] as const;

const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;

const MODULE_KEY = "ai_agent_lifecycle_manager";
const REGISTRY_PATH = "/admin/clinical-ai/agent-registry";
const HEALTH_REPORTS_PATH = "/admin/clinical-ai/agent-registry/health-reports";

type AgentHealthDecision = "accepted" | "deferred" | "rejected" | "edited";

type AgentStage = (typeof STAGES)[number];
type ApprovalStatus = (typeof APPROVAL_STATES)[number];

type AgentRegistryRow = {
  id: number;
  agent_key: string;
  display_name: string | null;
  owner: string | null;
  purpose: string | null;
  stage: AgentStage;
  expiry_date: string | null;
  last_seen_at: string | null;
  approval_status: ApprovalStatus;
  approval_note: string | null;
  approved_at: string | null;
  retired_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type AgentRegistryListResult = {
  agents?: AgentRegistryRow[];
  count?: number;
};

type AgentHealthRow = {
  id: number;
  agent_registry_id: number | null;
  agent_key: string;
  invocation_count: number;
  success_count: number;
  error_count: number;
  avg_latency_ms: number | null;
  permission_mismatch_count: number;
  days_since_last_seen: number | null;
  days_to_expiry: number | null;
  recommendation: string;
  severity: string;
  summary: string | null;
  reviewer_decision: string;
  created_at: string | null;
};

type AgentUpsertPayload = {
  agent_key: string;
  display_name?: string | null;
  owner?: string | null;
  purpose?: string | null;
  scopes?: string[];
  permitted_actions?: string[];
  expiry_date?: string | null;
};

type AgentStageChangePayload = {
  stage: AgentStage;
  approval_status?: ApprovalStatus | null;
  approval_note?: string | null;
};

type AgentHealthRecordPayload = {
  agent_key: string;
  invocation_count: number;
  success_count: number;
  error_count: number;
  avg_latency_ms: number | null;
  permission_mismatch_count: number;
  last_seen_at: string | null;
};

function toOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function computeSuccessPct(row: AgentHealthRow): string {
  if (row.invocation_count <= 0) return "-";
  const pct = (row.success_count / row.invocation_count) * 100;
  return `${pct.toFixed(1)}%`;
}

function computeErrorPct(row: AgentHealthRow): string {
  if (row.invocation_count <= 0) return "-";
  const pct = (row.error_count / row.invocation_count) * 100;
  return `${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Bottom-tier: health report decide queue columns / actions / filters.
// ---------------------------------------------------------------------------
const HEALTH_FILTERS: FilterSpec[] = [
  { key: "agent_key", label: "Agent key", kind: "text", placeholder: "agent key" },
  {
    key: "recommendation",
    label: "Recommendation",
    kind: "select",
    options: RECOMMENDATIONS.map((value) => ({ value, label: readableKey(value) })),
  },
  {
    key: "severity",
    label: "Severity",
    kind: "select",
    options: SEVERITIES.map((value) => ({ value, label: readableKey(value) })),
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: [
      { value: "pending", label: "Pending" },
      { value: "accepted", label: "Accepted" },
      { value: "deferred", label: "Deferred" },
      { value: "rejected", label: "Rejected" },
      { value: "edited", label: "Edited" },
    ],
  },
];

const HEALTH_COLUMNS: ColumnSpec<AgentHealthRow>[] = [
  {
    key: "agent",
    header: "Agent",
    render: (row) => (
      <div>
        <div className="font-mono text-xs font-medium">{row.agent_key}</div>
        {row.summary ? (
          <div className="text-xs text-muted-foreground">{row.summary}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => <span>{readableKey(row.recommendation)}</span>,
  },
  {
    key: "severity",
    header: "Severity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.severity)}`}
      >
        {row.severity || "unknown"}
      </span>
    ),
  },
  {
    key: "rates",
    header: "Success / Error",
    render: (row) => (
      <div className="text-xs">
        <div>{computeSuccessPct(row)}</div>
        <div className="text-muted-foreground">{computeErrorPct(row)}</div>
      </div>
    ),
  },
  {
    key: "latency",
    header: "Avg latency",
    render: (row) =>
      row.avg_latency_ms === null || row.avg_latency_ms === undefined
        ? "-"
        : `${Math.round(row.avg_latency_ms)} ms`,
  },
  {
    key: "days_to_expiry",
    header: "Days to expiry",
    render: (row) =>
      row.days_to_expiry === null || row.days_to_expiry === undefined
        ? "-"
        : row.days_to_expiry,
  },
  {
    key: "decision",
    header: "Review status",
    render: (row) => (
      <span className="text-xs">{readableKey(row.reviewer_decision)}</span>
    ),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const HEALTH_DECIDE_ACTIONS: DecideAction<AgentHealthDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

// ---------------------------------------------------------------------------
// Top-tier: agent registry list + upsert + stage/approval change.
// ---------------------------------------------------------------------------
function AgentRegistrySection() {
  const queryClient = useQueryClient();
  const [stageFilter, setStageFilter] = useState<string>("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");

  const registry = useQuery({
    queryKey: ["clinical-ai", MODULE_KEY, "registry", stageFilter, ownerFilter],
    queryFn: () => {
      const params: Record<string, unknown> = {};
      if (stageFilter) params.stage = stageFilter;
      if (ownerFilter) params.owner = ownerFilter;
      return listClinicalAi(REGISTRY_PATH, params) as Promise<
        AgentRegistryListResult & { count: number }
      >;
    },
  });

  const [agentKey, setAgentKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [owner, setOwner] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scopes, setScopes] = useState("");
  const [permittedActions, setPermittedActions] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["clinical-ai", MODULE_KEY] });
    queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
  };

  const upsert = useMutation({
    mutationFn: (payload: AgentUpsertPayload) =>
      evaluateClinicalAi(REGISTRY_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Agent registry saved");
      invalidateAll();
      setDisplayName("");
      setOwner("");
      setPurpose("");
      setScopes("");
      setPermittedActions("");
      setExpiryDate("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save agent registry entry"),
  });

  const changeStage = useMutation({
    mutationFn: ({
      registryId,
      payload,
    }: {
      registryId: number;
      payload: AgentStageChangePayload;
    }) =>
      patchClinicalAi(
        `${REGISTRY_PATH}/${registryId}/stage`,
        payload as Record<string, unknown>
      ),
    onSuccess: () => {
      toast.success("Agent stage updated");
      invalidateAll();
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to change agent stage"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = agentKey.trim();
    if (!key) {
      toast.error("agent_key is required");
      return;
    }
    upsert.mutate({
      agent_key: key,
      display_name: displayName.trim() || null,
      owner: owner.trim() || null,
      purpose: purpose.trim() || null,
      scopes: splitCsv(scopes),
      permitted_actions: splitCsv(permittedActions),
      expiry_date: expiryDate || null,
    });
  };

  const onStageChange = (row: AgentRegistryRow, nextStage: AgentStage) => {
    if (nextStage === row.stage) return;
    const note = window.prompt(
      `Note for stage change to ${nextStage} (optional)`
    );
    changeStage.mutate({
      registryId: row.id,
      payload: { stage: nextStage, approval_note: note ?? null },
    });
  };

  const onApprovalChange = (
    row: AgentRegistryRow,
    nextApproval: ApprovalStatus
  ) => {
    if (nextApproval === row.approval_status) return;
    const note = window.prompt(
      `Note for approval change to ${nextApproval} (optional)`
    );
    changeStage.mutate({
      registryId: row.id,
      payload: {
        stage: row.stage,
        approval_status: nextApproval,
        approval_note: note ?? null,
      },
    });
  };

  const rows = registry.data?.agents ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Agent Registry</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Filter by stage"
          >
            <option value="">All stages</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {readableKey(value)}
              </option>
            ))}
          </select>
          <input
            value={ownerFilter}
            onChange={(event) => setOwnerFilter(event.target.value)}
            placeholder="owner"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Filter by owner"
          />
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Agent key *</span>
            <input
              value={agentKey}
              onChange={(event) => setAgentKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. summariser_v2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Owner</span>
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-3">
            <span className="text-muted-foreground">Purpose</span>
            <input
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="what the agent does"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scopes (CSV)</span>
            <input
              value={scopes}
              onChange={(event) => setScopes(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="read_patient_summary, write_draft"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Permitted actions (CSV)</span>
            <input
              value={permittedActions}
              onChange={(event) => setPermittedActions(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="draft_note, publish_translation"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Expiry date</span>
            <input
              type="date"
              value={expiryDate}
              onChange={(event) => setExpiryDate(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {upsert.isPending ? "Saving…" : "Save agent"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Agent</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Owner</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Stage</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Approval</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Expiry</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {registry.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  Loading…
                </td>
              </tr>
            ) : registry.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-600"
                  colSpan={6}
                >
                  {(registry.error as Error)?.message || "Failed to load agents"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  No agents registered
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      {row.display_name ?? row.agent_key}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {row.agent_key}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">{row.owner ?? "-"}</td>
                  <td className="px-4 py-3">
                    <select
                      value={row.stage}
                      onChange={(event) =>
                        onStageChange(row, event.target.value as AgentStage)
                      }
                      disabled={changeStage.isPending}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      aria-label={`Change stage for ${row.agent_key}`}
                    >
                      {STAGES.map((value) => (
                        <option key={value} value={value}>
                          {readableKey(value)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={row.approval_status}
                      onChange={(event) =>
                        onApprovalChange(
                          row,
                          event.target.value as ApprovalStatus
                        )
                      }
                      disabled={changeStage.isPending}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      aria-label={`Change approval for ${row.agent_key}`}
                    >
                      {APPROVAL_STATES.map((value) => (
                        <option key={value} value={value}>
                          {readableKey(value)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs">{row.expiry_date ?? "-"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.last_seen_at)}
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
// Bottom-tier: health-report record form + shared decide queue.
// ---------------------------------------------------------------------------
function AgentHealthRecordForm() {
  const queryClient = useQueryClient();
  const [agentKey, setAgentKey] = useState("");
  const [invocationCount, setInvocationCount] = useState("");
  const [successCount, setSuccessCount] = useState("");
  const [errorCount, setErrorCount] = useState("");
  const [avgLatencyMs, setAvgLatencyMs] = useState("");
  const [permissionMismatch, setPermissionMismatch] = useState("");
  const [lastSeenAt, setLastSeenAt] = useState("");

  const record = useMutation({
    mutationFn: (payload: AgentHealthRecordPayload) =>
      evaluateClinicalAi(
        HEALTH_REPORTS_PATH,
        payload as Record<string, unknown>
      ),
    onSuccess: () => {
      toast.success("Agent health report recorded");
      setInvocationCount("");
      setSuccessCount("");
      setErrorCount("");
      setAvgLatencyMs("");
      setPermissionMismatch("");
      setLastSeenAt("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", MODULE_KEY] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to record health report"),
  });

  const canSubmit = agentKey.trim().length > 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    record.mutate({
      agent_key: agentKey.trim(),
      invocation_count: Number(invocationCount) || 0,
      success_count: Number(successCount) || 0,
      error_count: Number(errorCount) || 0,
      avg_latency_ms: toOptionalNumber(avgLatencyMs),
      permission_mismatch_count: Number(permissionMismatch) || 0,
      last_seen_at: lastSeenAt || null,
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">Agent key *</span>
          <input
            value={agentKey}
            onChange={(event) => setAgentKey(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="existing registry agent_key"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Last seen at</span>
          <input
            type="datetime-local"
            value={lastSeenAt}
            onChange={(event) => setLastSeenAt(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Invocations</span>
          <input
            value={invocationCount}
            onChange={(event) => setInvocationCount(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Successes</span>
          <input
            value={successCount}
            onChange={(event) => setSuccessCount(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Errors</span>
          <input
            value={errorCount}
            onChange={(event) => setErrorCount(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Avg latency (ms)</span>
          <input
            value={avgLatencyMs}
            onChange={(event) => setAvgLatencyMs(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Permission mismatches</span>
          <input
            value={permissionMismatch}
            onChange={(event) => setPermissionMismatch(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={record.isPending || !canSubmit}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {record.isPending ? "Recording…" : "Record health report"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function AiAgentLifecyclePanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">AI Agent Lifecycle Manager</h2>
      </div>

      <AgentRegistrySection />

      <ClinicalAIReviewQueue<AgentHealthRow, AgentHealthDecision>
        title="Agent Health Reports"
        moduleKey={MODULE_KEY}
        icon={<Bot className="h-4 w-4" />}
        description="Record a health report to draft a lifecycle recommendation, then review and decide."
        listFn={(params) => listClinicalAi(HEALTH_REPORTS_PATH, params)}
        rowsKey="reports"
        decideFn={(id, decision, note) =>
          decideClinicalAi(HEALTH_REPORTS_PATH, id, decision, note)
        }
        filters={HEALTH_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={HEALTH_COLUMNS}
        decideActions={HEALTH_DECIDE_ACTIONS}
        evaluateForm={<AgentHealthRecordForm />}
        emptyState="No agent health reports pending review"
      />
    </section>
  );
}
