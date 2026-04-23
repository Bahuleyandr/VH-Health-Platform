"use client";

// Phase-2 clinical-AI panel. Tracker row 13 — icu_ventilator_sedation_bundle.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3042/3057).
// Service: apps/backend/src/services/ai/icuVentilatorBundleService.js
//          (listVentilatorBundleAudits / decideVentilatorBundleAudit).

import { Activity } from "lucide-react";

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
// Row shape — returned by `listVentilatorBundleAudits`. `bundle_gaps` is a
// jsonb array of item objects, rendered via a count here.
// ---------------------------------------------------------------------------
type VentilatorBundleAuditRow = {
  id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  ventilator_status: string | null;
  ventilator_days: number | null;
  compliance_score: number | string | null;
  risk_band: string | null;
  bundle_gaps: unknown;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, escalated.
// See FINAL_DECISIONS in icuVentilatorBundleService.js.
type VentilatorBundleDecision = "accepted" | "deferred" | "rejected" | "escalated";

const RISK_BAND_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const VENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ventilated", label: "Ventilated" },
  { value: "weaning", label: "Weaning" },
  { value: "extubated", label: "Extubated" },
  { value: "not_ventilated", label: "Not ventilated" },
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
  { key: "risk_band", label: "Risk", kind: "select", options: RISK_BAND_OPTIONS },
  {
    key: "ventilator_status",
    label: "Vent status",
    kind: "select",
    options: VENT_STATUS_OPTIONS,
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

function toComplianceScore(value: number | string | null): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function gapCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

const KPIS: KpiSpec<VentilatorBundleAuditRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "High / critical",
    compute: (rows) =>
      rows.filter((row) =>
        ["high", "critical"].includes((row.risk_band || "").toLowerCase())
      ).length,
  },
  {
    label: "Avg gaps",
    compute: (rows) => {
      if (!rows.length) return 0;
      const total = rows.reduce((sum, row) => sum + gapCount(row.bundle_gaps), 0);
      return (total / rows.length).toFixed(1);
    },
  },
];

function patientPreview(row: VentilatorBundleAuditRow): string {
  const uid = row.patient_uid ?? "";
  if (!uid) return "-";
  return uid.length > 8 ? `${uid.slice(0, 8)}…` : uid;
}

const COLUMNS: ColumnSpec<VentilatorBundleAuditRow>[] = [
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
    key: "compliance_score",
    header: "Compliance",
    render: (row) => {
      const score = toComplianceScore(row.compliance_score);
      return `${score.toFixed(0)}%`;
    },
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
    key: "gap_count",
    header: "Gaps",
    render: (row) => gapCount(row.bundle_gaps),
  },
  {
    key: "vent_status",
    header: "Vent status",
    render: (row) => readableKey(row.ventilator_status),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<VentilatorBundleDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "muted", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/icu-ventilator-bundle/audits";

export default function IcuVentilatorBundlePanel() {
  return (
    <ClinicalAIReviewQueue<VentilatorBundleAuditRow, VentilatorBundleDecision>
      title="ICU Ventilator + Sedation Bundle"
      moduleKey="icu_ventilator_sedation_bundle"
      icon={<Activity className="h-4 w-4" />}
      description="VAP bundle, sedation vacation, and SBT readiness audits for mechanically ventilated ICU patients."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="audits"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No ICU ventilator bundle audits pending review"
    />
  );
}
