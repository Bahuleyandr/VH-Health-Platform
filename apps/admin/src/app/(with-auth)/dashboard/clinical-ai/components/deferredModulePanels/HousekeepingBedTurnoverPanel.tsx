"use client";

// Phase-2 clinical-AI panel. Tracker row 22 — housekeeping_bed_turnover.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3276/3292).
// Service: apps/backend/src/services/ai/housekeepingBedTurnoverService.js
//          (listBedTurnoverPredictions / decideBedTurnoverPrediction).

import { Bed } from "lucide-react";

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
// Row shape — `normalizePredictionRow` output from housekeepingBedTurnover.
// The backend SELECT returns bed_id + ward + room_number; there is no
// `bed_number` column, so we render "Bed #id" fallback when room_number is
// missing.
// ---------------------------------------------------------------------------
type BedTurnoverPredictionRow = {
  id: number;
  bed_id: number | null;
  ward: string | null;
  room_number: string | null;
  discharge_time: string | null;
  current_status: string | null;
  required_cleaning_level: string | null;
  predicted_turnover_minutes: number;
  priority_score: number;
  priority_band: string | null;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, escalated.
// See FINAL_DECISIONS in housekeepingBedTurnoverService.js.
type BedTurnoverDecision = "accepted" | "deferred" | "rejected" | "escalated";

const PRIORITY_BAND_OPTIONS: { value: string; label: string }[] = [
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
  { value: "escalated", label: "Escalated" },
];

const FILTERS: FilterSpec[] = [
  { key: "ward", label: "Ward", kind: "text", placeholder: "Ward" },
  {
    key: "priority_band",
    label: "Priority",
    kind: "select",
    options: PRIORITY_BAND_OPTIONS,
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const KPIS: KpiSpec<BedTurnoverPredictionRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "High / critical",
    compute: (rows) =>
      rows.filter((row) =>
        ["high", "critical"].includes((row.priority_band || "").toLowerCase())
      ).length,
  },
  {
    label: "Avg turnover (min)",
    compute: (rows) => {
      if (!rows.length) return 0;
      const total = rows.reduce(
        (sum, row) => sum + (row.predicted_turnover_minutes ?? 0),
        0
      );
      return (total / rows.length).toFixed(0);
    },
  },
];

function bedLabel(row: BedTurnoverPredictionRow): string {
  if (row.room_number) return row.room_number;
  if (row.bed_id !== null && row.bed_id !== undefined) return `Bed #${row.bed_id}`;
  return "-";
}

const COLUMNS: ColumnSpec<BedTurnoverPredictionRow>[] = [
  {
    key: "bed",
    header: "Bed / ward",
    render: (row) => (
      <div>
        <div className="font-medium">{bedLabel(row)}</div>
        <div className="text-xs text-muted-foreground">{row.ward ?? "-"}</div>
      </div>
    ),
  },
  {
    key: "cleaning_level",
    header: "Cleaning",
    render: (row) => readableKey(row.required_cleaning_level),
  },
  {
    key: "turnover_minutes",
    header: "Turnover (min)",
    render: (row) => (row.predicted_turnover_minutes ?? 0).toFixed(0),
  },
  {
    key: "priority_band",
    header: "Priority",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.priority_band ?? "")}`}
      >
        {row.priority_band ?? "-"}
      </span>
    ),
  },
  {
    key: "priority_score",
    header: "Score",
    render: (row) => (row.priority_score ?? 0).toFixed(0),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<BedTurnoverDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "muted", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/bed-turnover/predictions";

export default function HousekeepingBedTurnoverPanel() {
  return (
    <ClinicalAIReviewQueue<BedTurnoverPredictionRow, BedTurnoverDecision>
      title="Housekeeping / Bed Turnover"
      moduleKey="housekeeping_bed_turnover"
      icon={<Bed className="h-4 w-4" />}
      description="Per-bed turnover minutes + priority band between discharge and next admit. Decision support only."
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
      emptyState="No bed turnover predictions pending review"
    />
  );
}
