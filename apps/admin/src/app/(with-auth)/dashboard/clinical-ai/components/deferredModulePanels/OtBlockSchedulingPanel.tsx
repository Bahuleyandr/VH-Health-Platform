"use client";

// Phase-2 clinical-AI panel. Tracker row 23 — ot_block_scheduling.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3737, 3754).
// Service:       apps/backend/src/services/ai/otBlockSchedulingService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'suggestions').

import { CalendarRange } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
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
// Row shape — mirrors normalizeSuggestionRow on the backend. Only the fields
// the table / KPIs render are modeled; unknown columns flow through via
// Record<string, unknown> semantics in the shared queue accessors.
// ---------------------------------------------------------------------------
type OtBlockSuggestionRow = {
  id: number;
  surgeon_uid: string | null;
  surgeon_name: string | null;
  service_line: string | null;
  block_label: string | null;
  or_room: string | null;
  utilization_pct: number | null;
  prime_time_utilization_pct: number | null;
  recommendation: string;
  severity: string;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited (see FINAL_DECISIONS).
type OtBlockDecision = "accepted" | "deferred" | "rejected" | "edited";

const RECOMMENDATION_OPTIONS: { value: string; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "expand", label: "Expand" },
  { value: "reduce", label: "Reduce" },
  { value: "reallocate", label: "Reallocate" },
  { value: "review_release_policy", label: "Review release policy" },
  { value: "unknown", label: "Unknown" },
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
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
  { key: "surgeon_uid", label: "Surgeon UID", kind: "text", placeholder: "Surgeon UID" },
  { key: "service_line", label: "Service line", kind: "text", placeholder: "Service line" },
  { key: "recommendation", label: "Recommendation", kind: "select", options: RECOMMENDATION_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

const KPIS: KpiSpec<OtBlockSuggestionRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const s = (row.severity || "").toLowerCase();
        return s === "critical" || s === "high";
      }).length,
    helpText: "Severity of released rule-based assessment",
  },
];

const COLUMNS: ColumnSpec<OtBlockSuggestionRow>[] = [
  {
    key: "surgeon",
    header: "Surgeon",
    render: (row) => (
      <div>
        <div className="font-medium">{row.surgeon_name ?? "-"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.surgeon_uid ?? "-"}
        </div>
      </div>
    ),
  },
  {
    key: "block_label",
    header: "Block",
    render: (row) => row.block_label ?? "-",
  },
  {
    key: "service_line",
    header: "Service line",
    render: (row) => row.service_line ?? "-",
  },
  {
    key: "utilization_pct",
    header: "Utilization %",
    render: (row) =>
      row.utilization_pct === null || row.utilization_pct === undefined
        ? "-"
        : `${Number(row.utilization_pct).toFixed(1)}%`,
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.recommendation)}
      </span>
    ),
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
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<OtBlockDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/ot/blocks";

export default function OtBlockSchedulingPanel() {
  return (
    <ClinicalAIReviewQueue<OtBlockSuggestionRow, OtBlockDecision>
      title="OT Block Scheduling Assistant"
      moduleKey="ot_block_scheduling"
      icon={<CalendarRange className="h-4 w-4" />}
      description="Per-surgeon OT block recommendations (keep / expand / reduce / reallocate / review release)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="suggestions"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No OT block suggestions pending review"
    />
  );
}
