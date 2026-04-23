"use client";

// Phase-2 clinical-AI panel. Tracker row 31 — model_registry_workbench.
// Two-tier module: top tier = model registry (upsert + list + stage change); bottom = eval runs (record + list + decide).
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (lines 3965-4085).

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, GitBranch, PlayCircle, Save } from "lucide-react";
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
} from "@/lib/api/clinicalAiGeneric";
import { fetchAdminAPI } from "@/lib/api/core";

// ---------------------------------------------------------------------------
// Reference data mirrors STAGES / APPROVAL_STATES / RECOMMENDATIONS /
// SEVERITIES / FINAL_DECISIONS in
// apps/backend/src/services/ai/modelRegistryWorkbenchService.js.
// ---------------------------------------------------------------------------
const STAGES = [
  "sandbox",
  "staging",
  "production",
  "deprecated",
  "quarantined",
  "unknown",
] as const;

type StageValue = (typeof STAGES)[number];

const APPROVAL_STATES = [
  "pending",
  "approved",
  "revoked",
  "rejected",
  "pending_retirement",
] as const;

const RECOMMENDATIONS = [
  "promote",
  "hold",
  "rollback",
  "retire",
  "no_action",
  "quarantine",
  "unknown",
] as const;

const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const STAGE_OPTIONS = STAGES.map((value) => ({ value, label: readableKey(value) }));

const APPROVAL_OPTIONS = APPROVAL_STATES.map((value) => ({
  value,
  label: readableKey(value),
}));

const RECOMMENDATION_FILTER_OPTIONS = RECOMMENDATIONS.map((value) => ({
  value,
  label: readableKey(value),
}));

const DECISION_FILTER_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "edited", label: "Edited" },
];

type EvalDecision = "accepted" | "deferred" | "rejected" | "edited";

type ModelRegistryRow = {
  id: number;
  model_key: string;
  version: string;
  provider: string | null;
  purpose: string | null;
  owner: string | null;
  stage: string;
  approval_status: string | null;
  approval_note: string | null;
  approved_at: string | null;
  retired_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ModelListResult = {
  models?: ModelRegistryRow[];
  count?: number;
};

type EvalRunRow = {
  id: number;
  model_registry_id: number | null;
  model_key: string;
  version: string;
  suite: string;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  accuracy: number | null;
  f1_score: number | null;
  avg_latency_ms: number | null;
  fallback_rate_pct: number | null;
  safety_flag_rate_pct: number | null;
  drift_score: number | null;
  recommendation: string;
  severity: string;
  summary: string | null;
  reviewer_decision: string;
  reviewed_at: string | null;
  created_at: string | null;
};

const REGISTRY_PATH = "/admin/clinical-ai/model-registry";
const EVAL_RUNS_PATH = "/admin/clinical-ai/model-registry/eval-runs";

const EVAL_FILTERS: FilterSpec[] = [
  { key: "model_key", label: "Model key", kind: "text", placeholder: "model key" },
  { key: "version", label: "Version", kind: "text", placeholder: "version" },
  {
    key: "recommendation",
    label: "Recommendation",
    kind: "select",
    options: RECOMMENDATION_FILTER_OPTIONS,
  },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const EVAL_DECIDE_ACTIONS: DecideAction<EvalDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(digits);
}

const EVAL_COLUMNS: ColumnSpec<EvalRunRow>[] = [
  {
    key: "model",
    header: "Model",
    render: (row) => (
      <div>
        <div className="font-medium">{row.model_key}</div>
        <div className="font-mono text-xs text-muted-foreground">{row.version}</div>
      </div>
    ),
  },
  {
    key: "suite",
    header: "Suite",
    render: (row) => <span className="text-xs">{row.suite}</span>,
  },
  {
    key: "accuracy",
    header: "Accuracy",
    render: (row) => formatPct(row.accuracy),
  },
  {
    key: "f1",
    header: "F1",
    render: (row) => formatPct(row.f1_score),
  },
  {
    key: "fallback",
    header: "Fallback %",
    render: (row) => formatPct(row.fallback_rate_pct),
  },
  {
    key: "drift",
    header: "Drift",
    render: (row) => formatPct(row.drift_score, 3),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => readableKey(row.recommendation),
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
    key: "reviewer_decision",
    header: "Review",
    render: (row) => readableKey(row.reviewer_decision),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Top tier — model registry (upsert + list + stage change).
// ---------------------------------------------------------------------------
type RegistryUpsertPayload = {
  model_key: string;
  version: string;
  provider?: string | null;
  purpose?: string | null;
  owner?: string | null;
  parent_version?: string | null;
};

function ModelRegistrySection() {
  const queryClient = useQueryClient();

  const models = useQuery({
    queryKey: ["clinical-ai", "model_registry_workbench", "registry"],
    queryFn: () =>
      listClinicalAi(REGISTRY_PATH, {}) as Promise<ModelListResult & { count: number }>,
  });

  const [modelKey, setModelKey] = useState("");
  const [version, setVersion] = useState("");
  const [provider, setProvider] = useState("");
  const [purpose, setPurpose] = useState("");
  const [owner, setOwner] = useState("");

  const upsert = useMutation({
    mutationFn: (payload: RegistryUpsertPayload) =>
      evaluateClinicalAi(REGISTRY_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Model saved");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "model_registry_workbench", "registry"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "model_registry_workbench"],
      });
      setModelKey("");
      setVersion("");
      setProvider("");
      setPurpose("");
      setOwner("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save model"),
  });

  const stageChange = useMutation({
    mutationFn: async ({
      id,
      stage,
      approvalNote,
    }: {
      id: number;
      stage: StageValue;
      approvalNote?: string | null;
    }) => {
      const body: Record<string, unknown> = { stage };
      if (approvalNote) body.approval_note = approvalNote;
      return fetchAdminAPI<Record<string, unknown>>(
        `${REGISTRY_PATH}/${id}/stage`,
        { method: "PATCH", body },
      );
    },
    onSuccess: () => {
      toast.success("Stage updated");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "model_registry_workbench", "registry"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "model_registry_workbench"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Stage change failed"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = modelKey.trim();
    const ver = version.trim();
    if (!key || !ver) {
      toast.error("model_key and version are required");
      return;
    }
    upsert.mutate({
      model_key: key,
      version: ver,
      provider: provider.trim() || null,
      purpose: purpose.trim() || null,
      owner: owner.trim() || null,
    });
  };

  const handleStageChange = (row: ModelRegistryRow, next: StageValue) => {
    if (next === row.stage) return;
    const approvalNote = window.prompt(
      `Approval note for stage change ${row.stage} -> ${next} (optional)`,
    );
    stageChange.mutate({
      id: row.id,
      stage: next,
      approvalNote: approvalNote ?? null,
    });
  };

  const rows = models.data?.models ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Model Registry</h3>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="mb-2 text-sm font-medium">Upsert model entry</div>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Model key</span>
            <input
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. triage-v2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Version</span>
            <input
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. 1.3.0"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Provider</span>
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Purpose</span>
            <input
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
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
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {upsert.isPending ? "Saving..." : "Save model"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Model key
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Version
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Provider
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Stage
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Approval
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Owner
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={7}
                >
                  Loading...
                </td>
              </tr>
            ) : models.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-700"
                  colSpan={7}
                >
                  {(models.error as Error | undefined)?.message ??
                    "Failed to load models"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={7}
                >
                  No models on file
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-medium">{row.model_key}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.version}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.provider ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={
                        STAGES.includes(row.stage as StageValue)
                          ? (row.stage as StageValue)
                          : "unknown"
                      }
                      onChange={(event) =>
                        handleStageChange(row, event.target.value as StageValue)
                      }
                      disabled={stageChange.isPending}
                      aria-label={`Stage for ${row.model_key} ${row.version}`}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    >
                      {STAGE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {row.approval_status
                      ? readableKey(row.approval_status)
                      : "-"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.owner ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.updated_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Approval states: {APPROVAL_OPTIONS.map((opt) => opt.label).join(", ")}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bottom tier — eval run record form + review queue.
// ---------------------------------------------------------------------------
function EvalRunForm() {
  const queryClient = useQueryClient();
  const [modelKey, setModelKey] = useState("");
  const [version, setVersion] = useState("");
  const [suite, setSuite] = useState("");
  const [accuracy, setAccuracy] = useState("");
  const [f1Score, setF1Score] = useState("");
  const [fallbackRatePct, setFallbackRatePct] = useState("");
  const [driftScore, setDriftScore] = useState("");

  const record = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        model_key: modelKey.trim(),
        version: version.trim(),
        suite: suite.trim(),
      };
      const parseNum = (value: string): number | null => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const parsed = Number.parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const acc = parseNum(accuracy);
      if (acc !== null) body.accuracy = acc;
      const f1 = parseNum(f1Score);
      if (f1 !== null) body.f1_score = f1;
      const fallback = parseNum(fallbackRatePct);
      if (fallback !== null) body.fallback_rate_pct = fallback;
      const drift = parseNum(driftScore);
      if (drift !== null) body.drift_score = drift;
      return evaluateClinicalAi(EVAL_RUNS_PATH, body);
    },
    onSuccess: () => {
      toast.success("Eval run recorded");
      setSuite("");
      setAccuracy("");
      setF1Score("");
      setFallbackRatePct("");
      setDriftScore("");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "model_registry_workbench"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Eval recording failed"),
  });

  const canSubmit =
    modelKey.trim().length > 0 &&
    version.trim().length > 0 &&
    suite.trim().length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        record.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-2 text-sm font-medium">Record an eval run</div>
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Model key</span>
          <input
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Version</span>
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Suite</span>
          <input
            value={suite}
            onChange={(event) => setSuite(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="e.g. safety-regression"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Accuracy</span>
          <input
            value={accuracy}
            onChange={(event) => setAccuracy(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">F1 score</span>
          <input
            value={f1Score}
            onChange={(event) => setF1Score(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Fallback rate %</span>
          <input
            value={fallbackRatePct}
            onChange={(event) => setFallbackRatePct(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Drift score</span>
          <input
            value={driftScore}
            onChange={(event) => setDriftScore(event.target.value)}
            inputMode="decimal"
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
          {record.isPending ? "Recording..." : "Record run"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function ModelRegistryWorkbenchPanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Model Registry Workbench</h2>
      </div>

      <ModelRegistrySection />

      <ClinicalAIReviewQueue<EvalRunRow, EvalDecision>
        title="Eval Runs"
        moduleKey="model_registry_workbench"
        icon={<FlaskConical className="h-4 w-4" />}
        description="Decision-support only. Rule-based recommendations are never auto-applied — an AI eval lead must decide each run."
        listFn={(params) => listClinicalAi(EVAL_RUNS_PATH, params)}
        rowsKey="runs"
        decideFn={(id, decision, note) =>
          decideClinicalAi(EVAL_RUNS_PATH, id, decision, note)
        }
        filters={EVAL_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={EVAL_COLUMNS}
        decideActions={EVAL_DECIDE_ACTIONS}
        evaluateForm={<EvalRunForm />}
        emptyState="No eval runs pending review"
      />
    </section>
  );
}
