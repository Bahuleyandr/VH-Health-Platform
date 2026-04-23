"use client";

// Phase-2 clinical-AI panel. Tracker row 24 — inventory_intelligence.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (3806, 3824).
// Service:       apps/backend/src/services/ai/inventoryIntelligenceService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'alerts').

import { Boxes } from "lucide-react";

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
// Row shape — mirrors normalizeAlertRow on the backend.
// ---------------------------------------------------------------------------
type InventoryAlertRow = {
  id: number;
  item_sku: string | null;
  item_name: string | null;
  category: string | null;
  ward: string | null;
  alert_category: string;
  severity: string;
  current_stock: number | null;
  reorder_point: number | null;
  days_on_hand: number | null;
  days_to_expiry: number | null;
  reviewer_decision: string;
  created_at: string | null;
};

type InventoryDecision = "accepted" | "deferred" | "rejected" | "edited";

const ALERT_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "stockout_risk", label: "Stockout risk" },
  { value: "reorder_point_breach", label: "Reorder point breach" },
  { value: "expiry_risk", label: "Expiry risk" },
  { value: "consumption_anomaly", label: "Consumption anomaly" },
  { value: "overstock", label: "Overstock" },
  { value: "healthy", label: "Healthy" },
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
  { key: "ward", label: "Ward", kind: "text", placeholder: "Ward" },
  { key: "category", label: "Category", kind: "text", placeholder: "Item category" },
  { key: "alert_category", label: "Alert", kind: "select", options: ALERT_CATEGORY_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

const KPIS: KpiSpec<InventoryAlertRow>[] = [
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
    label: "Stockout risk",
    compute: (rows) =>
      rows.filter((row) => row.alert_category === "stockout_risk").length,
  },
];

const COLUMNS: ColumnSpec<InventoryAlertRow>[] = [
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
    key: "category",
    header: "Category",
    render: (row) => row.category ?? "-",
  },
  {
    key: "ward",
    header: "Ward",
    render: (row) => row.ward ?? "-",
  },
  {
    key: "alert_category",
    header: "Alert",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.alert_category)}
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
    key: "days_on_hand",
    header: "Days on hand",
    render: (row) =>
      row.days_on_hand === null || row.days_on_hand === undefined
        ? "-"
        : row.days_on_hand,
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<InventoryDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/inventory/alerts";

export default function InventoryIntelligencePanel() {
  return (
    <ClinicalAIReviewQueue<InventoryAlertRow, InventoryDecision>
      title="Inventory Intelligence"
      moduleKey="inventory_intelligence"
      icon={<Boxes className="h-4 w-4" />}
      description="Non-pharmacy inventory alerts (stockout, reorder, expiry, overstock, anomaly)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="alerts"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No inventory alerts pending review"
    />
  );
}
