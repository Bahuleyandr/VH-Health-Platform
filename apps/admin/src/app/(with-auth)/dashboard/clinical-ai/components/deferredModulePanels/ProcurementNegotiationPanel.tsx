"use client";

// Phase-2 clinical-AI panel. Tracker row 30 — procurement_negotiation_assistant.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4125, 4143).
// Service:       apps/backend/src/services/ai/procurementNegotiationService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'opportunities').

import { Handshake } from "lucide-react";

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
// Row shape — mirrors normalizeOpportunityRow on the backend.
// ---------------------------------------------------------------------------
type ProcurementOpportunityRow = {
  id: number;
  item_sku: string | null;
  item_name: string | null;
  category: string | null;
  vendor_name: string | null;
  opportunity_category: string;
  severity: string;
  price_delta_pct: number | null;
  estimated_annual_savings: number | null;
  reviewer_decision: string;
  created_at: string | null;
};

type ProcurementDecision = "accepted" | "deferred" | "rejected" | "edited";

const OPPORTUNITY_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "price_anomaly", label: "Price anomaly" },
  { value: "volume_consolidation", label: "Volume consolidation" },
  { value: "tenure_leverage", label: "Tenure leverage" },
  { value: "alternatives_available", label: "Alternatives available" },
  { value: "expiring_contract", label: "Expiring contract" },
  { value: "no_action", label: "No action" },
  { value: "unknown", label: "Unknown" },
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
  { key: "item_sku", label: "Item SKU", kind: "text", placeholder: "Item SKU" },
  { key: "vendor_name", label: "Vendor", kind: "text", placeholder: "Vendor name" },
  { key: "opportunity_category", label: "Category", kind: "select", options: OPPORTUNITY_CATEGORY_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  try {
    return value.toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    });
  } catch {
    return String(value);
  }
}

const KPIS: KpiSpec<ProcurementOpportunityRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const s = (row.severity || "").toLowerCase();
        return s === "critical" || s === "high";
      }).length,
  },
  {
    label: "Est. annual savings",
    compute: (rows) => {
      const total = rows.reduce(
        (sum, row) => sum + (Number(row.estimated_annual_savings) || 0),
        0
      );
      return formatMoney(total);
    },
    helpText: "Sum across visible opportunities",
  },
];

const COLUMNS: ColumnSpec<ProcurementOpportunityRow>[] = [
  {
    key: "item",
    header: "Item",
    render: (row) => (
      <div>
        <div className="font-medium">{row.item_name ?? "-"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.item_sku ?? "-"}
        </div>
      </div>
    ),
  },
  {
    key: "vendor_name",
    header: "Vendor",
    render: (row) => row.vendor_name ?? "-",
  },
  {
    key: "opportunity_category",
    header: "Category",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.opportunity_category)}
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
    key: "price_delta_pct",
    header: "Price Δ %",
    render: (row) =>
      row.price_delta_pct === null || row.price_delta_pct === undefined
        ? "-"
        : `${Number(row.price_delta_pct).toFixed(1)}%`,
  },
  {
    key: "estimated_annual_savings",
    header: "Est. annual savings",
    render: (row) => formatMoney(row.estimated_annual_savings),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<ProcurementDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/procurement/opportunities";

export default function ProcurementNegotiationPanel() {
  return (
    <ClinicalAIReviewQueue<ProcurementOpportunityRow, ProcurementDecision>
      title="Procurement Negotiation Assistant"
      moduleKey="procurement_negotiation_assistant"
      icon={<Handshake className="h-4 w-4" />}
      description="Per-item negotiation opportunities (price anomaly, consolidation, tenure, alternatives, expiry)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="opportunities"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No procurement opportunities pending review"
    />
  );
}
