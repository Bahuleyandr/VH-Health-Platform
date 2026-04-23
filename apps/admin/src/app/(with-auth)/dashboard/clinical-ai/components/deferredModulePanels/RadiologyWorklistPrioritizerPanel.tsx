"use client";

// Phase-2 clinical-AI panel. Tracker row 15 — radiology_worklist_prioritizer.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3664/3680).
// Service: apps/backend/src/services/ai/radiologyWorklistPrioritizerService.js
//          (listWorklistPriorities / decideWorklistPriority).

import { ListOrdered } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
  type KpiSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Row shape — `normalizePriorityRow` output from the service.
// ---------------------------------------------------------------------------
type WorklistPriorityRow = {
  id: number;
  study_id: string | null;
  accession_number: string | null;
  modality: string | null;
  body_part: string | null;
  priority_tier: string;
  priority_score: number | string | null;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited.
// See FINAL_DECISIONS in radiologyWorklistPrioritizerService.js.
type WorklistPriorityDecision = "accepted" | "deferred" | "rejected" | "edited";

const PRIORITY_TIER_OPTIONS: { value: string; label: string }[] = [
  { value: "stat", label: "STAT" },
  { value: "urgent", label: "Urgent" },
  { value: "routine", label: "Routine" },
  { value: "deferrable", label: "Deferrable" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "edited", label: "Edited" },
];

const FILTERS: FilterSpec[] = [
  { key: "modality", label: "Modality", kind: "text", placeholder: "CT, MRI, US…" },
  {
    key: "priority_tier",
    label: "Tier",
    kind: "select",
    options: PRIORITY_TIER_OPTIONS,
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

function priorityTierBadgeClass(tier: string): string {
  const t = (tier || "").toLowerCase();
  if (t === "stat") return "bg-red-100 text-red-800 border-red-200";
  if (t === "urgent") return "bg-orange-100 text-orange-800 border-orange-200";
  if (t === "routine") return "bg-amber-100 text-amber-800 border-amber-200";
  if (t === "deferrable") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function toPriorityScore(value: number | string | null): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

const KPIS: KpiSpec<WorklistPriorityRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "STAT",
    compute: (rows) =>
      rows.filter((row) => (row.priority_tier || "").toLowerCase() === "stat").length,
  },
  {
    label: "STAT + Urgent",
    compute: (rows) =>
      rows.filter((row) =>
        ["stat", "urgent"].includes((row.priority_tier || "").toLowerCase())
      ).length,
  },
];

const COLUMNS: ColumnSpec<WorklistPriorityRow>[] = [
  {
    key: "study_id",
    header: "Study",
    render: (row) => (
      <div>
        <div className="font-mono text-xs">{row.study_id ?? "-"}</div>
        {row.accession_number ? (
          <div className="text-xs text-muted-foreground">
            Acc: {row.accession_number}
          </div>
        ) : null}
      </div>
    ),
  },
  {
    key: "modality",
    header: "Modality",
    render: (row) => (
      <div>
        <div className="font-medium">{row.modality ?? "-"}</div>
        {row.body_part ? (
          <div className="text-xs text-muted-foreground">{readableKey(row.body_part)}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: "priority_tier",
    header: "Tier",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorityTierBadgeClass(row.priority_tier)}`}
      >
        {row.priority_tier || "-"}
      </span>
    ),
  },
  {
    key: "priority_score",
    header: "Score",
    render: (row) => toPriorityScore(row.priority_score).toFixed(0),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<WorklistPriorityDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/radiology/worklist";

export default function RadiologyWorklistPrioritizerPanel() {
  return (
    <ClinicalAIReviewQueue<WorklistPriorityRow, WorklistPriorityDecision>
      title="Radiology Worklist Prioritizer"
      moduleKey="radiology_worklist_prioritizer"
      icon={<ListOrdered className="h-4 w-4" />}
      description="Score-based worklist ordering across STAT / urgent / routine / deferrable tiers. Decision support only."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="priorities"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No worklist priorities pending review"
    />
  );
}
