"use client";

// Phase-2 clinical-AI panel. Tracker row 19 — obstetric_risk_assistant.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3203/3220).
// Service: apps/backend/src/services/ai/obstetricRiskService.js
//          (listObstetricRiskAssessments / decideObstetricRiskAssessment).

import { Baby } from "lucide-react";

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
// Row shape — rows returned by `listObstetricRiskAssessments`.
// ---------------------------------------------------------------------------
type ObstetricRiskAssessmentRow = {
  id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  gestational_age_weeks: number | null;
  assessment_stage: string | null;
  risk_score: number | string | null;
  risk_band: string | null;
  red_flag_signals: unknown;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, escalated.
// See FINAL_DECISIONS in obstetricRiskService.js.
type ObstetricRiskDecision = "accepted" | "deferred" | "rejected" | "escalated";

const RISK_BAND_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "pre_conception", label: "Pre-conception" },
  { value: "first_trimester", label: "First trimester" },
  { value: "second_trimester", label: "Second trimester" },
  { value: "third_trimester", label: "Third trimester" },
  { value: "intrapartum", label: "Intrapartum" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "escalated", label: "Escalated" },
];

const FILTERS: FilterSpec[] = [
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "Patient UID" },
  { key: "stage", label: "Stage", kind: "select", options: STAGE_OPTIONS },
  { key: "risk_band", label: "Risk", kind: "select", options: RISK_BAND_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

function redFlagCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function toRiskScore(value: number | string | null): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

const KPIS: KpiSpec<ObstetricRiskAssessmentRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "High / critical risk",
    compute: (rows) =>
      rows.filter((row) =>
        ["high", "critical"].includes((row.risk_band || "").toLowerCase())
      ).length,
  },
  {
    label: "Red-flag signals",
    compute: (rows) =>
      rows.reduce((sum, row) => sum + redFlagCount(row.red_flag_signals), 0),
  },
];

function patientPreview(row: ObstetricRiskAssessmentRow): string {
  const uid = row.patient_uid ?? "";
  if (!uid) return "-";
  return uid.length > 8 ? `${uid.slice(0, 8)}…` : uid;
}

const COLUMNS: ColumnSpec<ObstetricRiskAssessmentRow>[] = [
  {
    key: "patient",
    header: "Patient",
    render: (row) => (
      <div>
        <div className="font-medium">{row.patient_name ?? "-"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {patientPreview(row)}
        </div>
      </div>
    ),
  },
  {
    key: "stage",
    header: "Stage",
    render: (row) => (
      <div>
        <div className="font-medium">{readableKey(row.assessment_stage)}</div>
        {row.gestational_age_weeks !== null && row.gestational_age_weeks !== undefined ? (
          <div className="text-xs text-muted-foreground">
            {row.gestational_age_weeks}w GA
          </div>
        ) : null}
      </div>
    ),
  },
  {
    key: "risk_band",
    header: "Risk",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.risk_band ?? "")}`}
      >
        {row.risk_band ?? "-"}
      </span>
    ),
  },
  {
    key: "risk_score",
    header: "Score",
    render: (row) => toRiskScore(row.risk_score).toFixed(0),
  },
  {
    key: "red_flags",
    header: "Red flags",
    render: (row) => redFlagCount(row.red_flag_signals),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<ObstetricRiskDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "muted", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/obstetric-risk/assessments";

export default function ObstetricRiskPanel() {
  return (
    <ClinicalAIReviewQueue<ObstetricRiskAssessmentRow, ObstetricRiskDecision>
      title="Obstetric Risk Assistant"
      moduleKey="obstetric_risk_assistant"
      icon={<Baby className="h-4 w-4" />}
      description="Gestation-stage aware risk assessments with red-flag detection. Decision support only."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="assessments"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No obstetric risk assessments pending review"
    />
  );
}
