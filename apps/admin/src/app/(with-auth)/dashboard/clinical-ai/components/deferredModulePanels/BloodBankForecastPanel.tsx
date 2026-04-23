"use client";

// Phase-2 clinical-AI panel. Tracker row 17 — blood_bank_demand_forecast.
// Two-tier module: top tier = inventory snapshots (upsert + list); bottom = forecast reviews (generate + list + decide).
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (lines 3076-3163).

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Droplets, PlayCircle, Save } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  evaluateClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Reference data mirrors BLOOD_GROUPS / COMPONENTS /
// RISK_BANDS / FINAL_DECISIONS in apps/backend/src/services/ai/bloodBankForecastService.js.
// ---------------------------------------------------------------------------
const BLOOD_GROUPS = ["O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-"] as const;

const COMPONENTS = [
  "packed_red_cells",
  "whole_blood",
  "platelets",
  "ffp",
  "cryoprecipitate",
] as const;

const RISK_BAND_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const DECISION_FILTER_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "escalated", label: "Escalated" },
];

type ForecastDecision = "accepted" | "deferred" | "rejected" | "escalated";

type InventoryRow = {
  id: number;
  blood_group: string;
  component: string;
  units_available: number;
  units_committed: number;
  minimum_stock_level: number;
  expires_earliest: string | null;
  updated_at: string | null;
  created_at: string | null;
};

type InventoryListResult = {
  inventory?: InventoryRow[];
  count?: number;
};

type StockoutRisk = {
  blood_group: string;
  component: string;
  units_available: number;
  units_committed: number;
  minimum_stock_level: number;
  predicted_units: number;
  projected_shortfall: number;
  risk_band: string;
  window_hours: number;
};

type MtpReadiness = {
  ready?: boolean;
  prbc_ok?: boolean;
  ffp_ok?: boolean;
  platelets_ok?: boolean;
};

type ForecastReviewRow = {
  id: number;
  generation_id: number | null;
  forecast_window_hours: number;
  forecast_start: string | null;
  forecast_end: string | null;
  stockout_risks: StockoutRisk[] | null;
  mtp_readiness: MtpReadiness | null;
  risk_band: string;
  recommendations: string[] | null;
  reviewer_decision: string;
  reviewed_at: string | null;
  created_at: string | null;
};

const INVENTORY_PATH = "/admin/clinical-ai/blood-bank/inventory";
const FORECASTS_PATH = "/admin/clinical-ai/blood-bank/forecasts";
const FORECAST_EVALUATE_PATH = "/admin/clinical-ai/blood-bank/forecast";

const FORECAST_FILTERS: FilterSpec[] = [
  { key: "risk_band", label: "Risk band", kind: "select", options: RISK_BAND_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const FORECAST_DECIDE_ACTIONS: DecideAction<ForecastDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
];

function stockoutCount(risks: StockoutRisk[] | null | undefined): number {
  if (!Array.isArray(risks)) return 0;
  return risks.filter(
    (row) => row.risk_band === "critical" || row.risk_band === "high"
  ).length;
}

const FORECAST_COLUMNS: ColumnSpec<ForecastReviewRow>[] = [
  {
    key: "window",
    header: "Forecast window",
    render: (row) => (
      <div>
        <div className="font-medium">{row.forecast_window_hours}h</div>
        <div className="text-xs text-muted-foreground">
          {fmt(row.forecast_start)} &rarr; {fmt(row.forecast_end)}
        </div>
      </div>
    ),
  },
  {
    key: "risk_band",
    header: "Overall risk",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.risk_band)}`}
      >
        {row.risk_band || "unknown"}
      </span>
    ),
  },
  {
    key: "mtp",
    header: "MTP ready",
    render: (row) => {
      const ready = Boolean(row.mtp_readiness?.ready);
      return (
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
            ready
              ? "bg-emerald-100 text-emerald-800 border-emerald-200"
              : "bg-red-100 text-red-800 border-red-200"
          }`}
        >
          {ready ? "yes" : "no"}
        </span>
      );
    },
  },
  {
    key: "stockout",
    header: "Stock-out risks",
    render: (row) => {
      const count = stockoutCount(row.stockout_risks);
      return (
        <div>
          <div className="font-medium">{count}</div>
          <div className="text-xs text-muted-foreground">critical + high</div>
        </div>
      );
    },
  },
  {
    key: "reviewer_decision",
    header: "Review",
    render: (row) => readableKey(row.reviewer_decision),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Top tier — inventory snapshots (upsert + list).
// ---------------------------------------------------------------------------
type InventoryUpsertPayload = {
  blood_group: string;
  component: string;
  units_available: number;
  units_committed?: number;
  minimum_stock_level?: number;
  expires_earliest?: string | null;
};

function InventorySection() {
  const queryClient = useQueryClient();

  const inventory = useQuery({
    queryKey: ["clinical-ai", "blood_bank_demand_forecast", "inventory"],
    queryFn: () =>
      listClinicalAi(INVENTORY_PATH, {}) as Promise<InventoryListResult & { count: number }>,
  });

  const [bloodGroup, setBloodGroup] = useState<string>(BLOOD_GROUPS[0]);
  const [component, setComponent] = useState<string>(COMPONENTS[0]);
  const [unitsAvailable, setUnitsAvailable] = useState("");
  const [unitsCommitted, setUnitsCommitted] = useState("");
  const [minimumStockLevel, setMinimumStockLevel] = useState("");
  const [expiresEarliest, setExpiresEarliest] = useState("");

  const upsert = useMutation({
    mutationFn: (payload: InventoryUpsertPayload) =>
      evaluateClinicalAi(INVENTORY_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Inventory snapshot saved");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "blood_bank_demand_forecast", "inventory"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "blood_bank_demand_forecast"],
      });
      setUnitsAvailable("");
      setUnitsCommitted("");
      setMinimumStockLevel("");
      setExpiresEarliest("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save inventory"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedAvailable = Number.parseInt(unitsAvailable, 10);
    if (!Number.isFinite(parsedAvailable) || parsedAvailable < 0) {
      toast.error("units_available must be a non-negative integer");
      return;
    }
    const committedRaw = unitsCommitted.trim();
    const minimumRaw = minimumStockLevel.trim();
    const payload: InventoryUpsertPayload = {
      blood_group: bloodGroup,
      component,
      units_available: parsedAvailable,
    };
    if (committedRaw) {
      const parsed = Number.parseInt(committedRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("units_committed must be a non-negative integer");
        return;
      }
      payload.units_committed = parsed;
    }
    if (minimumRaw) {
      const parsed = Number.parseInt(minimumRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("reorder point must be a non-negative integer");
        return;
      }
      payload.minimum_stock_level = parsed;
    }
    if (expiresEarliest) {
      payload.expires_earliest = expiresEarliest;
    }
    upsert.mutate(payload);
  };

  const rows = inventory.data?.inventory ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Droplets className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Blood Bank Inventory</h3>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="mb-2 text-sm font-medium">Upsert inventory snapshot</div>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6 lg:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Blood group</span>
            <select
              value={bloodGroup}
              onChange={(event) => setBloodGroup(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {BLOOD_GROUPS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Component</span>
            <select
              value={component}
              onChange={(event) => setComponent(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {COMPONENTS.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Units available</span>
            <input
              value={unitsAvailable}
              onChange={(event) => setUnitsAvailable(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Units committed</span>
            <input
              value={unitsCommitted}
              onChange={(event) => setUnitsCommitted(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Reorder point</span>
            <input
              value={minimumStockLevel}
              onChange={(event) => setMinimumStockLevel(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="minimum stock level"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Earliest expiry</span>
            <input
              type="date"
              value={expiresEarliest}
              onChange={(event) => setExpiresEarliest(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {upsert.isPending ? "Saving..." : "Save snapshot"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Group
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Component
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Units available
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Earliest expiry
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Reorder point
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {inventory.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  Loading...
                </td>
              </tr>
            ) : inventory.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-700"
                  colSpan={6}
                >
                  {(inventory.error as Error | undefined)?.message ??
                    "Failed to load inventory"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  No inventory snapshots on file
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.blood_group}</td>
                  <td className="px-4 py-3">{readableKey(row.component)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.units_available}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.units_committed} committed
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.expires_earliest ? fmt(row.expires_earliest) : "-"}
                  </td>
                  <td className="px-4 py-3">{row.minimum_stock_level}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.updated_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bottom tier — forecast generate form + review queue.
// ---------------------------------------------------------------------------
function ForecastEvaluateForm() {
  const queryClient = useQueryClient();
  const [windowHours, setWindowHours] = useState("24");

  const evaluate = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      const parsed = Number.parseInt(windowHours.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        body.forecast_window_hours = parsed;
      }
      return evaluateClinicalAi(FORECAST_EVALUATE_PATH, body);
    },
    onSuccess: () => {
      toast.success("Forecast generated");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "blood_bank_demand_forecast"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Forecast generation failed"),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        evaluate.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-2 text-sm font-medium">Generate a new forecast</div>
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Forecast window (hours, 1-168)</span>
          <input
            value={windowHours}
            onChange={(event) => setWindowHours(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={evaluate.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {evaluate.isPending ? "Generating..." : "Generate"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function BloodBankForecastPanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Droplets className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Blood Bank Demand Forecast</h2>
      </div>

      <InventorySection />

      <ClinicalAIReviewQueue<ForecastReviewRow, ForecastDecision>
        title="Forecast Reviews"
        moduleKey="blood_bank_demand_forecast"
        icon={<Droplets className="h-4 w-4" />}
        description="Decision-support only. Review each forecast before acting on recommendations — the service never auto-orders units."
        listFn={(params) => listClinicalAi(FORECASTS_PATH, params)}
        rowsKey="forecasts"
        decideFn={(id, decision, note) =>
          decideClinicalAi(FORECASTS_PATH, id, decision, note)
        }
        filters={FORECAST_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={FORECAST_COLUMNS}
        decideActions={FORECAST_DECIDE_ACTIONS}
        evaluateForm={<ForecastEvaluateForm />}
        emptyState="No forecasts pending review"
      />
    </section>
  );
}
