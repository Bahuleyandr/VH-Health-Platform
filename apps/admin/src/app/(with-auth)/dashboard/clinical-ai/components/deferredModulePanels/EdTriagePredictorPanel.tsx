"use client";

// Phase-2 clinical-AI panel. Tracker row 11 — ed_triage_boarding_predictor.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (2983/3000).
// Service: apps/backend/src/services/ai/edTriageBoardingService.js
//          (listEdTriagePredictions / decideEdTriagePrediction).

import { Ambulance } from "lucide-react";

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
// Row shape — `normalizePredictionRow` output from edTriageBoardingService.
// ---------------------------------------------------------------------------
type EdTriagePredictionRow = {
  id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  chief_complaint: string | null;
  triage_level: number | null;
  boarding_risk_band: string | null;
  boarding_risk_score: number | null;
  predicted_specialty: string | null;
  predicted_disposition: string | null;
  predicted_boarding_minutes: number | null;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, escalated.
// See FINAL_DECISIONS in edTriageBoardingService.js.
type EdTriageDecision = "accepted" | "deferred" | "rejected" | "escalated";

const BOARDING_BAND_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "insufficient_data", label: "Insufficient data" },
  { value: "unknown", label: "Unknown" },
];

const TRIAGE_LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "ESI 1 (Resuscitation)" },
  { value: "2", label: "ESI 2 (Emergent)" },
  { value: "3", label: "ESI 3 (Urgent)" },
  { value: "4", label: "ESI 4 (Less urgent)" },
  { value: "5", label: "ESI 5 (Non-urgent)" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "escalated", label: "Escalated" },
];

const FILTERS: FilterSpec[] = [
  { key: "triage_level", label: "ESI", kind: "select", options: TRIAGE_LEVEL_OPTIONS },
  {
    key: "boarding_band",
    label: "Boarding",
    kind: "select",
    options: BOARDING_BAND_OPTIONS,
  },
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "Patient UID" },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const KPIS: KpiSpec<EdTriagePredictionRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "High / critical boarding",
    compute: (rows) =>
      rows.filter((row) =>
        ["high", "critical"].includes((row.boarding_risk_band || "").toLowerCase())
      ).length,
  },
  {
    label: "ESI 1–2",
    compute: (rows) =>
      rows.filter((row) => row.triage_level === 1 || row.triage_level === 2).length,
  },
];

function patientPreview(row: EdTriagePredictionRow): string {
  const uid = row.patient_uid ?? "";
  if (!uid) return "-";
  return uid.length > 8 ? `${uid.slice(0, 8)}…` : uid;
}

const COLUMNS: ColumnSpec<EdTriagePredictionRow>[] = [
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
    key: "esi_level",
    header: "ESI",
    render: (row) => (row.triage_level === null || row.triage_level === undefined ? "-" : row.triage_level),
  },
  {
    key: "disposition",
    header: "Disposition",
    render: (row) => readableKey(row.predicted_disposition),
  },
  {
    key: "boarding_risk_band",
    header: "Boarding",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.boarding_risk_band ?? "")}`}
      >
        {row.boarding_risk_band ?? "-"}
      </span>
    ),
  },
  {
    key: "specialty",
    header: "Specialty",
    render: (row) => readableKey(row.predicted_specialty),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<EdTriageDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "muted", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/ed-triage/predictions";

export default function EdTriagePredictorPanel() {
  return (
    <ClinicalAIReviewQueue<EdTriagePredictionRow, EdTriageDecision>
      title="ED Triage + Boarding Predictor"
      moduleKey="ed_triage_boarding_predictor"
      icon={<Ambulance className="h-4 w-4" />}
      description="ESI triage level and boarding-time forecast per ED arrival. Decision support only."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="predictions"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No ED triage predictions pending review"
    />
  );
}
