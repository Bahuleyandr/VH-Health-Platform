"use client";

// Phase-2 clinical-AI panel. Tracker row 28 — training_simulation_coach.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3931, 3946).
// Service:       apps/backend/src/services/ai/trainingSimulationCoachService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'modules').

import { GraduationCap } from "lucide-react";

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
// Row shape — training modules carry severity at top level and risk_band
// inside metadata (see buildTrainingModule + INSERT in trainingSimulationCoachService).
// ---------------------------------------------------------------------------
type TrainingModuleMetadata = {
  risk_band?: string | null;
  risk_score?: number | null;
};

type TrainingModuleRow = {
  id: number;
  title: string | null;
  case_type: string;
  incident_category: string | null;
  severity: string;
  format: string;
  duration_minutes: number | null;
  reviewer_decision: string;
  created_at: string | null;
  metadata: TrainingModuleMetadata | null;
};

type TrainingDecision = "accepted" | "deferred" | "rejected" | "edited";

const CASE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "mortality", label: "Mortality" },
  { value: "near_miss", label: "Near miss" },
  { value: "safety_event", label: "Safety event" },
  { value: "delayed_diagnosis", label: "Delayed diagnosis" },
  { value: "medication_error", label: "Medication error" },
  { value: "handoff_failure", label: "Handoff failure" },
  { value: "infection_outbreak", label: "Infection outbreak" },
  { value: "equipment_failure", label: "Equipment failure" },
  { value: "other", label: "Other" },
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
  { key: "case_type", label: "Case type", kind: "select", options: CASE_TYPE_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function riskBandOf(row: TrainingModuleRow): string {
  const band = row.metadata?.risk_band;
  return typeof band === "string" && band.length > 0 ? band : row.severity;
}

const KPIS: KpiSpec<TrainingModuleRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const band = riskBandOf(row).toLowerCase();
        return band === "critical" || band === "high";
      }).length,
    helpText: "risk_band (metadata) + severity",
  },
];

const COLUMNS: ColumnSpec<TrainingModuleRow>[] = [
  {
    key: "title",
    header: "Title",
    render: (row) => <span className="font-medium">{row.title ?? "-"}</span>,
  },
  {
    key: "case_type",
    header: "Case type",
    render: (row) => readableKey(row.case_type),
  },
  {
    key: "risk_band",
    header: "Risk",
    render: (row) => {
      const band = riskBandOf(row);
      return (
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(band)}`}
        >
          {band || "unknown"}
        </span>
      );
    },
  },
  {
    key: "format",
    header: "Format",
    render: (row) => readableKey(row.format),
  },
  {
    key: "duration_minutes",
    header: "Duration (min)",
    render: (row) =>
      row.duration_minutes === null || row.duration_minutes === undefined
        ? "-"
        : row.duration_minutes,
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<TrainingDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/training/modules";

export default function TrainingSimulationCoachPanel() {
  return (
    <ClinicalAIReviewQueue<TrainingModuleRow, TrainingDecision>
      title="Training Simulation Coach"
      moduleKey="training_simulation_coach"
      icon={<GraduationCap className="h-4 w-4" />}
      description="Rule-based simulation training modules (draft-for-review)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="modules"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No training modules pending review"
    />
  );
}
