"use client";

// Phase-2 clinical-AI panel. Tracker row 32 — dataset_labeling_studio.
// Two-tier module: top tier = labeling tasks (create + list); bottom = annotations (submit + list + decide).
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (lines 4405-4508).

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, PlayCircle, Save, Tag } from "lucide-react";
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

// ---------------------------------------------------------------------------
// Reference data mirrors TASK_STATUSES / AGREEMENT_BANDS / CONFIDENCE_BANDS /
// DIFFICULTIES / FINAL_DECISIONS in
// apps/backend/src/services/ai/datasetLabelingStudioService.js.
// ---------------------------------------------------------------------------
const TASK_STATUSES = [
  "pending",
  "in_progress",
  "ready_to_use",
  "conflict",
  "rejected",
  "archived",
] as const;

const AGREEMENT_BANDS = [
  "match",
  "partial",
  "disagree",
  "pending",
  "unknown",
] as const;

const CONFIDENCE_BANDS = ["high", "medium", "low", "unknown"] as const;

const DIFFICULTIES = ["easy", "standard", "hard", "edge", "unknown"] as const;

const TASK_STATUS_OPTIONS = TASK_STATUSES.map((value) => ({
  value,
  label: readableKey(value),
}));

const AGREEMENT_OPTIONS = AGREEMENT_BANDS.map((value) => ({
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

type AnnotationDecision = "accepted" | "deferred" | "rejected" | "edited";

type LabelingTaskRow = {
  id: number;
  dataset_key: string;
  task_type: string;
  item_key: string;
  input_ref_type: string | null;
  input_ref_id: string | null;
  required_labelers: number;
  difficulty: string | null;
  status: string;
  confidence_band: string | null;
  agreement: string | null;
  consensus_label: unknown;
  created_at: string | null;
  updated_at: string | null;
};

type TaskListResult = {
  tasks?: LabelingTaskRow[];
  count?: number;
};

type AnnotationRow = {
  id: number;
  task_id: number | null;
  labeler_uid: string | null;
  generation_id: number | null;
  label: unknown;
  reviewer_decision: string;
  reviewed_at: string | null;
  confidence_score: number | null;
  created_at: string | null;
};

const TASKS_PATH = "/admin/clinical-ai/labeling/tasks";
const ANNOTATIONS_PATH = "/admin/clinical-ai/labeling/annotations";

const ANNOTATION_FILTERS: FilterSpec[] = [
  { key: "task_id", label: "Task ID", kind: "text", placeholder: "task id" },
  {
    key: "labeler_uid",
    label: "Labeler UID",
    kind: "text",
    placeholder: "labeler uid",
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const ANNOTATION_DECIDE_ACTIONS: DecideAction<AnnotationDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

function statusBadgeClass(status: string | null | undefined): string {
  const s = (status || "").toLowerCase();
  if (s === "conflict") return "bg-red-100 text-red-800 border-red-200";
  if (s === "rejected") return "bg-red-100 text-red-800 border-red-200";
  if (s === "ready_to_use") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (s === "in_progress") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function agreementBadgeClass(agreement: string | null | undefined): string {
  const a = (agreement || "").toLowerCase();
  if (a === "match") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (a === "partial") return "bg-amber-100 text-amber-800 border-amber-200";
  if (a === "disagree") return "bg-red-100 text-red-800 border-red-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function confidenceBadgeClass(band: string | null | undefined): string {
  const b = (band || "").toLowerCase();
  if (b === "high") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (b === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  if (b === "low") return "bg-red-100 text-red-800 border-red-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function shortenLabel(value: unknown, max = 40): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max - 1)}...` : value;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return "-";
    return serialized.length > max
      ? `${serialized.slice(0, max - 1)}...`
      : serialized;
  } catch {
    return "-";
  }
}

const ANNOTATION_COLUMNS: ColumnSpec<AnnotationRow>[] = [
  {
    key: "task",
    header: "Task",
    render: (row) => (
      <div className="font-mono text-xs">
        {row.task_id !== null ? `#${row.task_id}` : "-"}
      </div>
    ),
  },
  {
    key: "labeler",
    header: "Labeler",
    render: (row) => (
      <div className="font-mono text-xs text-muted-foreground">
        {row.labeler_uid ?? "-"}
      </div>
    ),
  },
  {
    key: "label",
    header: "Label",
    render: (row) => (
      <div className="text-xs text-muted-foreground">
        {shortenLabel(row.label)}
      </div>
    ),
  },
  {
    key: "confidence",
    header: "Confidence",
    render: (row) => {
      if (row.confidence_score === null || row.confidence_score === undefined) {
        return "-";
      }
      return row.confidence_score.toFixed(2);
    },
  },
  {
    key: "reviewer_decision",
    header: "Review",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.reviewer_decision)}`}
      >
        {readableKey(row.reviewer_decision)}
      </span>
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

// ---------------------------------------------------------------------------
// Top tier — labeling tasks (create + list).
// ---------------------------------------------------------------------------
type TaskUpsertPayload = {
  dataset_key: string;
  task_type: string;
  item_key: string;
  input_ref_type?: string | null;
  input_ref_id?: string | null;
  required_labelers?: number;
  difficulty?: string;
};

function LabelingTasksSection() {
  const queryClient = useQueryClient();

  const tasks = useQuery({
    queryKey: ["clinical-ai", "dataset_labeling_studio", "tasks"],
    queryFn: () =>
      listClinicalAi(TASKS_PATH, {}) as Promise<TaskListResult & { count: number }>,
  });

  const [datasetKey, setDatasetKey] = useState("");
  const [taskType, setTaskType] = useState("");
  const [itemKey, setItemKey] = useState("");
  const [requiredLabelers, setRequiredLabelers] = useState("2");
  const [difficulty, setDifficulty] = useState<string>("standard");

  const upsert = useMutation({
    mutationFn: (payload: TaskUpsertPayload) =>
      evaluateClinicalAi(TASKS_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Labeling task saved");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "dataset_labeling_studio", "tasks"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "dataset_labeling_studio"],
      });
      setItemKey("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save task"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ds = datasetKey.trim();
    const tt = taskType.trim();
    const item = itemKey.trim();
    if (!ds || !tt || !item) {
      toast.error("dataset_key, task_type, and item_key are required");
      return;
    }
    const payload: TaskUpsertPayload = {
      dataset_key: ds,
      task_type: tt,
      item_key: item,
      difficulty,
    };
    const labelersRaw = requiredLabelers.trim();
    if (labelersRaw) {
      const parsed = Number.parseInt(labelersRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        toast.error("required_labelers must be a positive integer");
        return;
      }
      payload.required_labelers = parsed;
    }
    upsert.mutate(payload);
  };

  const rows = tasks.data?.tasks ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Labeling Tasks</h3>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="mb-2 text-sm font-medium">Create labeling task</div>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Dataset key</span>
            <input
              value={datasetKey}
              onChange={(event) => setDatasetKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. triage-gold"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Task type</span>
            <input
              value={taskType}
              onChange={(event) => setTaskType(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. intent_label"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Item key</span>
            <input
              value={itemKey}
              onChange={(event) => setItemKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="unique item id"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Required labelers</span>
            <input
              value={requiredLabelers}
              onChange={(event) => setRequiredLabelers(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Difficulty</span>
            <select
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {DIFFICULTIES.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {upsert.isPending ? "Saving..." : "Save task"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Dataset / Task
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Item
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Status
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Agreement
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Confidence
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tasks.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  Loading...
                </td>
              </tr>
            ) : tasks.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-700"
                  colSpan={6}
                >
                  {(tasks.error as Error | undefined)?.message ??
                    "Failed to load tasks"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  No labeling tasks on file
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.dataset_key}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.task_type}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.item_key}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(row.status)}`}
                    >
                      {readableKey(row.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${agreementBadgeClass(row.agreement)}`}
                    >
                      {readableKey(row.agreement ?? "unknown")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${confidenceBadgeClass(row.confidence_band)}`}
                    >
                      {readableKey(row.confidence_band ?? "unknown")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Status options: {TASK_STATUS_OPTIONS.map((opt) => opt.label).join(", ")} ·
        Agreement bands: {AGREEMENT_OPTIONS.map((opt) => opt.label).join(", ")} ·
        Confidence bands: {CONFIDENCE_BANDS.join(", ")}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bottom tier — annotation submit form + review queue.
// ---------------------------------------------------------------------------
function AnnotationSubmitForm() {
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState("");
  const [labelJson, setLabelJson] = useState("");
  const [labelerUid, setLabelerUid] = useState("");
  const [confidenceScore, setConfidenceScore] = useState("");

  const submit = useMutation({
    mutationFn: () => {
      const parsedTaskId = Number.parseInt(taskId.trim(), 10);
      if (!Number.isFinite(parsedTaskId) || parsedTaskId < 1) {
        throw new Error("task_id must be a positive integer");
      }
      let parsedLabel: unknown;
      const trimmedLabel = labelJson.trim();
      if (!trimmedLabel) {
        throw new Error("label is required");
      }
      try {
        parsedLabel = JSON.parse(trimmedLabel);
      } catch {
        parsedLabel = trimmedLabel;
      }
      const body: Record<string, unknown> = {
        task_id: parsedTaskId,
        label: parsedLabel,
      };
      const uid = labelerUid.trim();
      if (uid) body.labeler_uid = uid;
      const confidenceRaw = confidenceScore.trim();
      if (confidenceRaw) {
        const parsed = Number.parseFloat(confidenceRaw);
        if (!Number.isFinite(parsed)) {
          throw new Error("confidence_score must be numeric");
        }
        body.confidence_score = parsed;
      }
      return evaluateClinicalAi(ANNOTATIONS_PATH, body);
    },
    onSuccess: () => {
      toast.success("Annotation submitted");
      setLabelJson("");
      setConfidenceScore("");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "dataset_labeling_studio"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Annotation submit failed"),
  });

  const canSubmit = taskId.trim().length > 0 && labelJson.trim().length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        submit.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-2 text-sm font-medium">Submit annotation</div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Task ID</span>
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Label (string or JSON)</span>
          <input
            value={labelJson}
            onChange={(event) => setLabelJson(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder='e.g. "positive" or {"intent":"urgent"}'
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Labeler UID (optional)</span>
          <input
            value={labelerUid}
            onChange={(event) => setLabelerUid(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Confidence (0-1)</span>
          <input
            value={confidenceScore}
            onChange={(event) => setConfidenceScore(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={submit.isPending || !canSubmit}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {submit.isPending ? "Submitting..." : "Submit"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function DatasetLabelingStudioPanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Tag className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Dataset Labeling Studio</h2>
      </div>

      <LabelingTasksSection />

      <ClinicalAIReviewQueue<AnnotationRow, AnnotationDecision>
        title="Annotations"
        moduleKey="dataset_labeling_studio"
        icon={<Tag className="h-4 w-4" />}
        description="Decision-support only. Items are never auto-published into a dataset — an eval lead reviews each annotation."
        listFn={(params) => listClinicalAi(ANNOTATIONS_PATH, params)}
        rowsKey="annotations"
        decideFn={(id, decision, note) =>
          decideClinicalAi(ANNOTATIONS_PATH, id, decision, note)
        }
        filters={ANNOTATION_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={ANNOTATION_COLUMNS}
        decideActions={ANNOTATION_DECIDE_ACTIONS}
        evaluateForm={<AnnotationSubmitForm />}
        emptyState="No annotations pending review"
      />
    </section>
  );
}
