"use client";

// Phase-2 clinical-AI panel. Tracker row 29 — policy_regulation_watcher.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4545, 4561).
// Service:       apps/backend/src/services/ai/policyRegulationWatcherService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'diffs').

import { ScrollText } from "lucide-react";

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
// Row shape — mirrors normalizeDiffRow on the backend.
// ---------------------------------------------------------------------------
type PolicyDiffRow = {
  id: number;
  policy_key: string;
  policy_title: string | null;
  source: string | null;
  previous_version: string | null;
  current_version: string | null;
  impact_area: string;
  severity: string;
  added_section_count: number;
  removed_section_count: number;
  modified_section_count: number;
  reviewer_decision: string;
  created_at: string | null;
};

type PolicyDiffDecision = "accepted" | "deferred" | "rejected" | "edited";

const IMPACT_AREA_OPTIONS: { value: string; label: string }[] = [
  { value: "clinical", label: "Clinical" },
  { value: "billing", label: "Billing" },
  { value: "access", label: "Access" },
  { value: "privacy", label: "Privacy" },
  { value: "infection_control", label: "Infection control" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "none", label: "None" },
  { value: "mixed", label: "Mixed" },
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
  { key: "policy_key", label: "Policy key", kind: "text", placeholder: "Policy key" },
  { key: "impact_area", label: "Impact area", kind: "select", options: IMPACT_AREA_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

const KPIS: KpiSpec<PolicyDiffRow>[] = [
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
  },
  {
    label: "Clinical impact",
    compute: (rows) => rows.filter((row) => row.impact_area === "clinical").length,
  },
];

const COLUMNS: ColumnSpec<PolicyDiffRow>[] = [
  {
    key: "policy",
    header: "Policy",
    render: (row) => (
      <div>
        <div className="font-medium">{row.policy_title ?? "-"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.policy_key}
        </div>
      </div>
    ),
  },
  {
    key: "impact_area",
    header: "Impact area",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.impact_area)}
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
    key: "diff_counts",
    header: "Added / Removed / Modified",
    render: (row) => (
      <span className="font-mono text-xs">
        <span className="text-emerald-700">+{row.added_section_count}</span>
        {" / "}
        <span className="text-red-700">-{row.removed_section_count}</span>
        {" / "}
        <span className="text-amber-700">~{row.modified_section_count}</span>
      </span>
    ),
  },
  {
    key: "created_at",
    header: "Detected",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<PolicyDiffDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/policy-diffs";

export default function PolicyRegulationWatcherPanel() {
  return (
    <ClinicalAIReviewQueue<PolicyDiffRow, PolicyDiffDecision>
      title="Policy & Regulation Watcher"
      moduleKey="policy_regulation_watcher"
      icon={<ScrollText className="h-4 w-4" />}
      description="Policy / guideline diffs flagged with impact area, severity, and section counts."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="diffs"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No policy diffs pending review"
    />
  );
}
