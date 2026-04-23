"use client";

// Phase-2 clinical-AI panel. Tracker row 39 — ai_explainability_dashboard.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4190, 4206).
// Service:       apps/backend/src/services/ai/aiExplainabilityDashboardService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'reports').

import { Microscope } from "lucide-react";

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
// Row shape — mirrors normalizeReportRow on the backend. Note that
// `module_key` on the row is the SOURCE explanation module (the module being
// explained), not this panel's own module_key.
// ---------------------------------------------------------------------------
type ExplainabilityReportRow = {
  id: number;
  module_key: string;
  patient_uid: string | null;
  trust_band: string;
  severity: string;
  citation_coverage_pct: number;
  unsupported_claim_count: number;
  numeric_coherence_pct: number;
  phi_leakage_count: number;
  bias_marker_count: number;
  reviewer_decision: string;
  created_at: string | null;
};

type ExplainabilityDecision = "accepted" | "deferred" | "rejected" | "edited";

const TRUST_BAND_OPTIONS: { value: string; label: string }[] = [
  { value: "trusted", label: "Trusted" },
  { value: "review", label: "Review" },
  { value: "reject", label: "Reject" },
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
  { key: "module_key", label: "Source module", kind: "text", placeholder: "Source module key" },
  { key: "trust_band", label: "Trust band", kind: "select", options: TRUST_BAND_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function trustBandBadgeClass(band: string): string {
  const b = (band || "").toLowerCase();
  if (b === "reject") return "bg-red-100 text-red-800 border-red-200";
  if (b === "review") return "bg-amber-100 text-amber-800 border-amber-200";
  if (b === "trusted") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

const KPIS: KpiSpec<ExplainabilityReportRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Trust: reject",
    compute: (rows) => rows.filter((row) => row.trust_band === "reject").length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const s = (row.severity || "").toLowerCase();
        return s === "critical" || s === "high";
      }).length,
  },
];

const COLUMNS: ColumnSpec<ExplainabilityReportRow>[] = [
  {
    key: "module_key",
    header: "Source module",
    render: (row) => (
      <div>
        <div className="font-mono text-xs">{row.module_key}</div>
        <div className="text-xs text-muted-foreground">{readableKey(row.module_key)}</div>
      </div>
    ),
  },
  {
    key: "trust_band",
    header: "Trust",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${trustBandBadgeClass(row.trust_band)}`}
      >
        {row.trust_band || "unknown"}
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
    key: "citation_coverage_pct",
    header: "Citations %",
    render: (row) => `${Number(row.citation_coverage_pct).toFixed(0)}%`,
  },
  {
    key: "unsupported_claim_count",
    header: "Unsupported",
    render: (row) =>
      row.unsupported_claim_count > 0 ? (
        <span className="font-mono text-xs text-orange-700">
          {row.unsupported_claim_count}
        </span>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">0</span>
      ),
  },
  {
    key: "phi_leakage_count",
    header: "PHI leaks",
    render: (row) =>
      row.phi_leakage_count > 0 ? (
        <span className="font-mono text-xs text-red-700">
          {row.phi_leakage_count}
        </span>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">0</span>
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

const DECIDE_ACTIONS: DecideAction<ExplainabilityDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/explainability/reports";

export default function AiExplainabilityDashboardPanel() {
  return (
    <ClinicalAIReviewQueue<ExplainabilityReportRow, ExplainabilityDecision>
      title="AI Explainability Dashboard"
      moduleKey="ai_explainability_dashboard"
      icon={<Microscope className="h-4 w-4" />}
      description="Per-module explainability reports (trust band, citation coverage, unsupported claims, PHI leakage)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="reports"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No explainability reports pending review"
    />
  );
}
