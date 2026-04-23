"use client";

// Phase-2 clinical-AI panel. Tracker row 10 — acuity_staffing_forecast.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4868/4884).
// Service: apps/backend/src/services/ai/acuityStaffingForecastService.js
//          (listAcuityStaffingForecasts / decideAcuityStaffingForecast).

import { Users } from "lucide-react";

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
// Row shape mirrors `normalizeForecastRow` output on the backend. We model
// only the fields the table renders.
// ---------------------------------------------------------------------------
type AcuityForecastRow = {
  id: number;
  unit: string | null;
  shift_label: string | null;
  shift_start: string | null;
  shift_end: string | null;
  census_total: number;
  census_critical: number;
  census_high: number;
  census_moderate: number;
  census_low: number;
  acuity_load: number;
  total_deficit: number;
  recommendation: string;
  severity: string;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited.
// See FINAL_DECISIONS in acuityStaffingForecastService.js.
type AcuityForecastDecision = "accepted" | "deferred" | "rejected" | "edited";

// RECOMMENDATIONS from the service minus 'unknown' — call_in / float_staff /
// hold_staffing / reduce_staff / no_action.
const RECOMMENDATION_OPTIONS: { value: string; label: string }[] = [
  { value: "no_action", label: "No action" },
  { value: "hold_staffing", label: "Hold staffing" },
  { value: "call_in", label: "Call in" },
  { value: "float_staff", label: "Float staff" },
  { value: "reduce_staff", label: "Reduce staff" },
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
  { key: "unit", label: "Unit", kind: "text", placeholder: "Unit name" },
  {
    key: "recommendation",
    label: "Recommendation",
    kind: "select",
    options: RECOMMENDATION_OPTIONS,
  },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const KPIS: KpiSpec<AcuityForecastRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "Critical",
    compute: (rows) =>
      rows.filter((row) => (row.severity || "").toLowerCase() === "critical").length,
  },
  {
    label: "Understaffed",
    compute: (rows) =>
      rows.filter((row) => (row.total_deficit ?? 0) > 0).length,
    helpText: "Forecasts with any deficit across roles",
  },
];

const COLUMNS: ColumnSpec<AcuityForecastRow>[] = [
  {
    key: "unit",
    header: "Unit",
    render: (row) => (
      <div>
        <div className="font-medium">{row.unit ?? "-"}</div>
        <div className="text-xs text-muted-foreground">
          {row.shift_label ?? "-"}
        </div>
      </div>
    ),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.severity)}`}
      >
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
    key: "total_deficit",
    header: "Deficit",
    render: (row) => (row.total_deficit ?? 0).toFixed(2),
  },
  {
    key: "census_total",
    header: "Census",
    render: (row) => row.census_total ?? 0,
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<AcuityForecastDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/acuity-staffing/forecasts";

export default function AcuityStaffingForecastPanel() {
  return (
    <ClinicalAIReviewQueue<AcuityForecastRow, AcuityForecastDecision>
      title="Acuity-Based Staffing Forecast"
      moduleKey="acuity_staffing_forecast"
      icon={<Users className="h-4 w-4" />}
      description="Shift-by-shift staffing deficits inferred from census + predicted flow. Decision support only."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="forecasts"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No acuity-staffing forecasts pending review"
    />
  );
}
