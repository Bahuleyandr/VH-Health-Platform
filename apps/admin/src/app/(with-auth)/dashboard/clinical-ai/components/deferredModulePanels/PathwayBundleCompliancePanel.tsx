"use client";

// Phase-2 clinical-AI panel. Tracker row 12 — pathway_bundle_compliance.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4672/4689).
// Service: apps/backend/src/services/ai/pathwayBundleComplianceService.js
//          (listPathwayBundleAudits / decidePathwayBundleAudit).

import { ClipboardCheck } from "lucide-react";

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
// Row shape — audit rows returned by `listPathwayBundleAudits`.
// ---------------------------------------------------------------------------
type PathwayBundleAuditRow = {
  id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  pathway_key: string | null;
  pathway_display: string | null;
  compliance_pct: number | string | null;
  compliant_count: number | null;
  late_count: number | null;
  missed_count: number | null;
  na_count: number | null;
  severity: string;
  recommendation: string;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited.
// See FINAL_DECISIONS in pathwayBundleComplianceService.js.
type PathwayBundleDecision = "accepted" | "deferred" | "rejected" | "edited";

const PATHWAY_KEY_OPTIONS: { value: string; label: string }[] = [
  { value: "stroke_gwg", label: "Stroke (GWG)" },
  { value: "acs_mona", label: "ACS (MONA)" },
  { value: "vte_prophylaxis", label: "VTE prophylaxis" },
  { value: "glycemic_insulin", label: "Glycemic / insulin" },
];

// RECOMMENDATIONS minus 'unknown': no_action, catch_up, escalate,
// review_pathway, critical_miss.
const RECOMMENDATION_OPTIONS: { value: string; label: string }[] = [
  { value: "no_action", label: "No action" },
  { value: "catch_up", label: "Catch up" },
  { value: "review_pathway", label: "Review pathway" },
  { value: "escalate", label: "Escalate" },
  { value: "critical_miss", label: "Critical miss" },
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
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "Patient UID" },
  { key: "pathway_key", label: "Pathway", kind: "select", options: PATHWAY_KEY_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  {
    key: "recommendation",
    label: "Recommendation",
    kind: "select",
    options: RECOMMENDATION_OPTIONS,
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

function toCompliancePct(value: number | string | null): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

const KPIS: KpiSpec<PathwayBundleAuditRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "Critical miss",
    compute: (rows) =>
      rows.filter((row) => row.recommendation === "critical_miss").length,
  },
  {
    label: "< 70% compliant",
    compute: (rows) =>
      rows.filter((row) => toCompliancePct(row.compliance_pct) < 70).length,
  },
];

function patientPreview(row: PathwayBundleAuditRow): string {
  const uid = row.patient_uid ?? "";
  if (!uid) return "-";
  return uid.length > 8 ? `${uid.slice(0, 8)}…` : uid;
}

const COLUMNS: ColumnSpec<PathwayBundleAuditRow>[] = [
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
    key: "pathway_key",
    header: "Pathway",
    render: (row) => (
      <div>
        <div className="font-medium">{readableKey(row.pathway_key)}</div>
        {row.pathway_display ? (
          <div className="text-xs text-muted-foreground">{row.pathway_display}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: "compliance_pct",
    header: "Compliance",
    render: (row) => {
      const pct = toCompliancePct(row.compliance_pct);
      return `${pct.toFixed(0)}%`;
    },
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
    key: "recommendation",
    header: "Recommendation",
    render: (row) => readableKey(row.recommendation),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<PathwayBundleDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/pathway-bundles";

export default function PathwayBundleCompliancePanel() {
  return (
    <ClinicalAIReviewQueue<PathwayBundleAuditRow, PathwayBundleDecision>
      title="Clinical Pathway / Bundle Compliance"
      moduleKey="pathway_bundle_compliance"
      icon={<ClipboardCheck className="h-4 w-4" />}
      description="Stroke, ACS, VTE, and glycemic bundle compliance audits. Decision support only."
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
      emptyState="No pathway bundle audits pending review"
    />
  );
}
