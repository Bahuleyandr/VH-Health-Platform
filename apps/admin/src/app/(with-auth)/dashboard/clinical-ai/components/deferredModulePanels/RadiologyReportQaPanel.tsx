"use client";

// Phase-2 clinical-AI panel. Tracker row 14 — radiology_report_qa.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3595/3611).
// Service: apps/backend/src/services/ai/radiologyReportQaService.js
//          (listRadiologyReportReviews / decideRadiologyReportReview).

import { Stethoscope } from "lucide-react";

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
// Row shape — rows returned by `listRadiologyReportReviews`.
// ---------------------------------------------------------------------------
type RadiologyReportReviewRow = {
  id: number;
  study_id: string | null;
  accession_number: string | null;
  modality: string | null;
  body_part: string | null;
  report_status: string | null;
  overall_severity: string | null;
  discrepancy_count: number | null;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited.
// See FINAL_DECISIONS in radiologyReportQaService.js.
type RadiologyReportDecision = "accepted" | "deferred" | "rejected" | "edited";

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
  { key: "modality", label: "Modality", kind: "text", placeholder: "CT, MRI, US…" },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const KPIS: KpiSpec<RadiologyReportReviewRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "Critical / high",
    compute: (rows) =>
      rows.filter((row) =>
        ["critical", "high"].includes((row.overall_severity || "").toLowerCase())
      ).length,
  },
  {
    label: "Total discrepancies",
    compute: (rows) =>
      rows.reduce((sum, row) => sum + (row.discrepancy_count ?? 0), 0),
  },
];

const COLUMNS: ColumnSpec<RadiologyReportReviewRow>[] = [
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
    render: (row) => row.modality ?? "-",
  },
  {
    key: "body_part",
    header: "Body part",
    render: (row) => readableKey(row.body_part),
  },
  {
    key: "overall_severity",
    header: "Severity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.overall_severity ?? "")}`}
      >
        {row.overall_severity ?? "-"}
      </span>
    ),
  },
  {
    key: "discrepancy_count",
    header: "Discrepancies",
    render: (row) => row.discrepancy_count ?? 0,
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

const DECIDE_ACTIONS: DecideAction<RadiologyReportDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/radiology/report-qa";

export default function RadiologyReportQaPanel() {
  return (
    <ClinicalAIReviewQueue<RadiologyReportReviewRow, RadiologyReportDecision>
      title="Radiology Report QA"
      moduleKey="radiology_report_qa"
      icon={<Stethoscope className="h-4 w-4" />}
      description="Discrepancy and completeness review for preliminary and final radiology reports."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="reviews"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No radiology report QA reviews pending"
    />
  );
}
