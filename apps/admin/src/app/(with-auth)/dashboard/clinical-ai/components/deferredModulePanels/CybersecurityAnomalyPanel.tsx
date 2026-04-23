"use client";

// Phase-2 clinical-AI panel. Tracker row 26 — cybersecurity_anomaly_detector.
// Backend: GET /admin/clinical-ai/security-anomalies (list),
//          PATCH /admin/clinical-ai/security-anomalies/:id (decide).
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3436/3451).
// Service:       apps/backend/src/services/ai/cybersecurityAnomalyService.js
//                (see listSecurityAnomalies / decideSecurityAnomaly).

import { Shield } from "lucide-react";

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
// Row shape (reflects the `normalizeAnomalyRow` output on the backend). We
// model only the fields the table renders — unknown columns come through as
// Record<string, unknown> because the shared queue works off accessors.
// ---------------------------------------------------------------------------
type AnomalySignal = {
  code?: string | null;
  title?: string | null;
  severity?: string | null;
};

type SecurityAnomalyRow = {
  id: number;
  subject_type: string;
  subject_id: string | null;
  anomaly_category: string;
  severity: string;
  risk_score: number | null;
  detected_at: string | null;
  created_at: string | null;
  reviewer_decision: string;
  signals: AnomalySignal[] | null;
};

// Backend accepts: acknowledged, investigating, resolved, false_positive, escalated.
// See FINAL_DECISIONS in cybersecurityAnomalyService.js. The spec's proposed
// `accepted|deferred|rejected` shortlist does not match what the backend
// validates, so we use the real decision set — noted as a deviation in the
// caller report.
type SecurityAnomalyDecision =
  | "acknowledged"
  | "investigating"
  | "resolved"
  | "false_positive"
  | "escalated";

const SUBJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "user_login", label: "User login" },
  { value: "admin_action", label: "Admin action" },
  { value: "device_traffic", label: "Device traffic" },
  { value: "data_export", label: "Data export" },
  { value: "api_usage", label: "API usage" },
  { value: "unknown", label: "Unknown" },
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "investigating", label: "Investigating" },
  { value: "resolved", label: "Resolved" },
  { value: "false_positive", label: "False positive" },
  { value: "escalated", label: "Escalated" },
];

const FILTERS: FilterSpec[] = [
  { key: "subject_type", label: "Subject", kind: "select", options: SUBJECT_TYPE_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

const KPIS: KpiSpec<SecurityAnomalyRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical",
    compute: (rows) =>
      rows.filter((row) => (row.severity || "").toLowerCase() === "critical").length,
  },
  {
    label: "Acknowledged",
    compute: (rows) =>
      rows.filter((row) => row.reviewer_decision === "acknowledged").length,
  },
];

const COLUMNS: ColumnSpec<SecurityAnomalyRow>[] = [
  {
    key: "subject",
    header: "Subject",
    render: (row) => (
      <div>
        <div className="font-medium">{readableKey(row.subject_type)}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.subject_id ?? "-"}
        </div>
      </div>
    ),
  },
  {
    key: "detector",
    header: "Detector",
    render: (row) => {
      const primary = (row.signals ?? [])[0];
      const code = primary?.code ?? row.anomaly_category ?? "-";
      const title = primary?.title;
      return (
        <div>
          <div className="font-mono text-xs">{code || "-"}</div>
          {title ? (
            <div className="text-xs text-muted-foreground">{title}</div>
          ) : null}
        </div>
      );
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
    key: "risk_score",
    header: "Risk",
    render: (row) =>
      row.risk_score === null || row.risk_score === undefined
        ? "-"
        : row.risk_score,
  },
  {
    key: "created_at",
    header: "Detected",
    render: (row) => (
      <span className="text-xs text-muted-foreground">
        {fmt(row.detected_at ?? row.created_at)}
      </span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<SecurityAnomalyDecision>[] = [
  { value: "acknowledged", label: "Acknowledge", variant: "primary" },
  { value: "investigating", label: "Investigate", variant: "warning" },
  { value: "resolved", label: "Resolve", variant: "success" },
  { value: "false_positive", label: "False positive", variant: "muted", promptForNote: true },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/security-anomalies";

export default function CybersecurityAnomalyPanel() {
  return (
    <ClinicalAIReviewQueue<SecurityAnomalyRow, SecurityAnomalyDecision>
      title="Cybersecurity Anomaly Detector"
      moduleKey="cybersecurity_anomaly_detector"
      icon={<Shield className="h-4 w-4" />}
      description="Security anomalies flagged for reviewer triage. Sort by severity then detection time."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="anomalies"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      emptyState="No security anomalies pending review"
    />
  );
}
