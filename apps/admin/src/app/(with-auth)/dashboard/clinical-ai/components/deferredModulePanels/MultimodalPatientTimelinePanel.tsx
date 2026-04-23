"use client";

// Phase-2 clinical-AI panel. Tracker row 37 — multimodal_patient_timeline.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4607, 4622).
// Service:       apps/backend/src/services/ai/multimodalPatientTimelineService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'snapshots').

import { Activity } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
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
// Row shape — mirrors normalizeSnapshotRow on the backend.
// overall_severity is drawn from RELEVANCE_BANDS, which includes
// 'informational' and 'unknown' on top of the usual low/moderate/high/critical.
// ---------------------------------------------------------------------------
type TimelineSnapshotRow = {
  id: number;
  patient_uid: string | null;
  admission_id: number | null;
  event_count: number;
  overall_severity: string;
  critical_count: number;
  high_count: number;
  moderate_count: number;
  low_count: number;
  informational_count: number;
  reviewer_decision: string;
  created_at: string | null;
};

type TimelineDecision = "accepted" | "deferred" | "rejected" | "edited";

const OVERALL_SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "informational", label: "Informational" },
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
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "Patient UID" },
  {
    key: "overall_severity",
    label: "Overall severity",
    kind: "select",
    options: OVERALL_SEVERITY_OPTIONS,
  },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function previewUid(uid: string | null): string {
  if (!uid) return "-";
  if (uid.length <= 10) return uid;
  return `${uid.slice(0, 8)}…`;
}

const KPIS: KpiSpec<TimelineSnapshotRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const s = (row.overall_severity || "").toLowerCase();
        return s === "critical" || s === "high";
      }).length,
  },
  {
    label: "Events summed",
    compute: (rows) =>
      rows.reduce((total, row) => total + (Number(row.event_count) || 0), 0),
  },
];

const COLUMNS: ColumnSpec<TimelineSnapshotRow>[] = [
  {
    key: "patient_uid",
    header: "Patient",
    render: (row) => (
      <span className="font-mono text-xs" title={row.patient_uid ?? undefined}>
        {previewUid(row.patient_uid)}
      </span>
    ),
  },
  {
    key: "event_count",
    header: "Events",
    render: (row) => row.event_count,
  },
  {
    key: "overall_severity",
    header: "Overall severity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.overall_severity)}`}
      >
        {row.overall_severity || "unknown"}
      </span>
    ),
  },
  {
    key: "critical_count",
    header: "Critical",
    render: (row) => (
      <span className="font-mono text-xs text-red-700">{row.critical_count}</span>
    ),
  },
  {
    key: "high_count",
    header: "High",
    render: (row) => (
      <span className="font-mono text-xs text-orange-700">{row.high_count}</span>
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

const DECIDE_ACTIONS: DecideAction<TimelineDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/patient-timeline/snapshots";

export default function MultimodalPatientTimelinePanel() {
  return (
    <ClinicalAIReviewQueue<TimelineSnapshotRow, TimelineDecision>
      title="Multimodal Patient Timeline"
      moduleKey="multimodal_patient_timeline"
      icon={<Activity className="h-4 w-4" />}
      description="Unified per-patient timelines with rolled-up event severity bands."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="snapshots"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No patient timeline snapshots pending review"
    />
  );
}
