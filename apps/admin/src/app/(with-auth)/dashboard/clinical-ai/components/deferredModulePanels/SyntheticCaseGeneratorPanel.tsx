"use client";

// Phase-2 clinical-AI panel. Tracker row 33 — synthetic_case_generator.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3869, 3884).
// Service:       apps/backend/src/services/ai/syntheticCaseGeneratorService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'cases').

import { FlaskConical } from "lucide-react";

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
// Row shape — cases carry edge_flags as a jsonb array; we derive the count.
// ---------------------------------------------------------------------------
type SyntheticCaseRow = {
  id: number;
  case_label: string | null;
  pathway: string;
  complexity: string;
  seed: string | null;
  edge_flags: unknown;
  reviewer_decision: string;
  created_at: string | null;
};

type SyntheticDecision = "accepted" | "deferred" | "rejected" | "edited";

const PATHWAY_OPTIONS: { value: string; label: string }[] = [
  { value: "sepsis", label: "Sepsis" },
  { value: "stroke", label: "Stroke" },
  { value: "chest_pain_acs", label: "Chest pain (ACS)" },
  { value: "pneumonia", label: "Pneumonia" },
  { value: "asthma_exacerbation", label: "Asthma exacerbation" },
  { value: "diabetic_ketoacidosis", label: "Diabetic ketoacidosis" },
  { value: "postpartum_hemorrhage", label: "Postpartum hemorrhage" },
  { value: "trauma_blunt", label: "Trauma (blunt)" },
  { value: "pediatric_fever", label: "Pediatric fever" },
  { value: "geriatric_fall", label: "Geriatric fall" },
  { value: "mental_health_crisis", label: "Mental health crisis" },
  { value: "unknown", label: "Unknown" },
];

const COMPLEXITY_OPTIONS: { value: string; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "standard", label: "Standard" },
  { value: "complex", label: "Complex" },
  { value: "edge", label: "Edge" },
  { value: "unknown", label: "Unknown" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "edited", label: "Edited" },
];

const FILTERS: FilterSpec[] = [
  { key: "pathway", label: "Pathway", kind: "select", options: PATHWAY_OPTIONS },
  { key: "complexity", label: "Complexity", kind: "select", options: COMPLEXITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function edgeFlagCount(row: SyntheticCaseRow): number {
  const flags = row.edge_flags;
  return Array.isArray(flags) ? flags.length : 0;
}

function complexityBadgeClass(complexity: string): string {
  const c = (complexity || "").toLowerCase();
  if (c === "edge") return "bg-red-100 text-red-800 border-red-200";
  if (c === "complex") return "bg-orange-100 text-orange-800 border-orange-200";
  if (c === "standard") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

const KPIS: KpiSpec<SyntheticCaseRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Edge cases",
    compute: (rows) =>
      rows.filter((row) => (row.complexity || "").toLowerCase() === "edge").length,
  },
  {
    label: "With edge flags",
    compute: (rows) => rows.filter((row) => edgeFlagCount(row) > 0).length,
  },
];

const COLUMNS: ColumnSpec<SyntheticCaseRow>[] = [
  {
    key: "case_label",
    header: "Case",
    render: (row) => <span className="font-medium">{row.case_label ?? "-"}</span>,
  },
  {
    key: "pathway",
    header: "Pathway",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.pathway)}
      </span>
    ),
  },
  {
    key: "complexity",
    header: "Complexity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${complexityBadgeClass(row.complexity)}`}
      >
        {row.complexity || "unknown"}
      </span>
    ),
  },
  {
    key: "edge_flag_count",
    header: "Edge flags",
    render: (row) => edgeFlagCount(row),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<SyntheticDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/synthetic-cases";

export default function SyntheticCaseGeneratorPanel() {
  return (
    <ClinicalAIReviewQueue<SyntheticCaseRow, SyntheticDecision>
      title="Synthetic Case Generator"
      moduleKey="synthetic_case_generator"
      icon={<FlaskConical className="h-4 w-4" />}
      description="Synthetic clinical cases for training and evaluation (pathway × complexity)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="cases"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No synthetic cases pending review"
    />
  );
}
