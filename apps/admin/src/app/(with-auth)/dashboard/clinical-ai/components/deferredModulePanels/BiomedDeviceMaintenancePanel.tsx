"use client";

// Phase-2 clinical-AI panel. Tracker row 25 — biomed_device_maintenance.
// Two-tier module: top tier = device registry (upsert + list); bottom = maintenance predictions (evaluate + list + decide).
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (lines 3311-3405).

import { useState, type ComponentType, type FormEvent, type SVGProps } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck,
  Cpu,
  FileCheck2,
  PlayCircle,
  RefreshCcw,
  Save,
  Wrench,
} from "lucide-react";
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
// Reference data mirrors DEVICE_TYPES / DEVICE_STATUSES / RISK_BANDS /
// URGENCIES / FINAL_DECISIONS in
// apps/backend/src/services/ai/biomedDeviceMaintenanceService.js.
// ---------------------------------------------------------------------------
const DEVICE_TYPES = [
  "ventilator",
  "defibrillator",
  "infusion_pump",
  "ecg_monitor",
  "ultrasound",
  "x_ray",
  "mri",
  "ct_scanner",
  "dialysis",
  "anesthesia_machine",
  "other",
] as const;

const DEVICE_STATUSES = [
  "in_service",
  "out_of_service",
  "retired",
  "pending_inspection",
  "unknown",
] as const;

const RISK_BAND_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const DEVICE_TYPE_FILTER_OPTIONS = DEVICE_TYPES.map((value) => ({
  value,
  label: readableKey(value),
}));

const DECISION_FILTER_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "escalated", label: "Escalated" },
];

type MaintenanceDecision = "accepted" | "deferred" | "rejected" | "escalated";

type BiomedDeviceRow = {
  id: number;
  device_code: string;
  device_type: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  location: string | null;
  installed_at: string | null;
  warranty_expires_on: string | null;
  last_preventive_maintenance_at: string | null;
  next_scheduled_maintenance_at: string | null;
  usage_hours: number;
  fault_events_last_90d: number;
  mean_time_between_failures_hours: number | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};

type DeviceListResult = {
  devices?: BiomedDeviceRow[];
  count?: number;
};

type ServiceWindow = {
  earliest_date?: string | null;
  latest_date?: string | null;
  urgency?: string | null;
};

type PredictionRow = {
  id: number;
  device_id: number | null;
  device_code: string | null;
  device_type?: string | null;
  predicted_failure_risk_score: number;
  risk_band: string;
  predicted_downtime_hours: number;
  recommended_service_window: ServiceWindow | null;
  contributing_signals: Array<{
    code?: string | null;
    severity?: string | null;
  }> | null;
  reviewer_decision: string;
  reviewed_at: string | null;
  created_at: string | null;
};

type CmmsStats = {
  device_count?: number;
  in_service_count?: number;
  overdue_device_count?: number;
  active_work_order_count?: number;
  urgent_work_order_count?: number;
  sla_breach_count?: number;
  downtime_minutes_30d?: number;
  current_count?: number;
  expired_or_failed_count?: number;
  due_soon_count?: number;
};

type CmmsDeviceRow = {
  id: number;
  device_code: string;
  device_type: string;
  location: string | null;
  status: string;
  next_scheduled_maintenance_at: string | null;
  usage_hours: number;
  fault_events_last_90d: number;
  amc_vendor: string | null;
  amc_expires_on: string | null;
};

type WorkOrderRow = {
  id: number;
  work_order_number: string;
  device_code: string | null;
  device_type: string | null;
  kind: string;
  priority: string;
  status: string;
  description: string;
  sla_due_at: string | null;
  sla_breached: boolean;
  downtime_minutes: number;
  source: string;
  created_at: string | null;
};

type CmmsBoardResult = {
  stats?: CmmsStats;
  devices?: CmmsDeviceRow[];
  work_orders?: WorkOrderRow[];
};

type CmmsStatCard = {
  label: string;
  value?: number;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const DEVICES_PATH = "/admin/clinical-ai/biomed-devices";
const PREDICTIONS_PATH = "/admin/clinical-ai/biomed-devices/predictions";
const EVALUATE_PATH = "/admin/clinical-ai/biomed-devices/evaluate";
const CMMS_PATH = "/admin/clinical-ai/biomed-cmms";

const PREDICTION_FILTERS: FilterSpec[] = [
  {
    key: "device_code",
    label: "Device code",
    kind: "text",
    placeholder: "filter by code",
  },
  { key: "risk_band", label: "Risk", kind: "select", options: RISK_BAND_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const PREDICTION_DECIDE_ACTIONS: DecideAction<MaintenanceDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "escalated", label: "Escalate", variant: "danger", promptForNote: true },
];

function urgencyBadgeClass(urgency: string | null | undefined) {
  const u = (urgency || "").toLowerCase();
  if (u === "immediate") return "bg-red-100 text-red-800 border-red-200";
  if (u === "within_7_days") return "bg-orange-100 text-orange-800 border-orange-200";
  if (u === "within_30_days") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function workOrderPriorityClass(priority: string | null | undefined) {
  const p = (priority || "").toLowerCase();
  if (p === "urgent") return "bg-red-100 text-red-800 border-red-200";
  if (p === "high") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function statValue(value: number | undefined) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "0";
}

function CreateWorkOrderFromPredictionButton({ row }: { row: PredictionRow }) {
  const queryClient = useQueryClient();
  const createWorkOrder = useMutation({
    mutationFn: () =>
      evaluateClinicalAi(`${CMMS_PATH}/work-orders/from-prediction/${row.id}`, {}),
    onSuccess: () => {
      toast.success("Work order created");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_device_maintenance"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_cmms"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to create work order"),
  });

  const enabled = row.reviewer_decision === "accepted";
  return (
    <button
      type="button"
      disabled={!enabled || createWorkOrder.isPending}
      onClick={() => createWorkOrder.mutate()}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
    >
      <Wrench className="h-3.5 w-3.5" />
      {createWorkOrder.isPending ? "Creating..." : "Create WO"}
    </button>
  );
}

const PREDICTION_COLUMNS: ColumnSpec<PredictionRow>[] = [
  {
    key: "device",
    header: "Device",
    render: (row) => (
      <div>
        <div className="font-mono text-xs">{row.device_code ?? "-"}</div>
        {row.device_type ? (
          <div className="text-xs text-muted-foreground">
            {readableKey(row.device_type)}
          </div>
        ) : null}
      </div>
    ),
  },
  {
    key: "risk_band",
    header: "Risk band",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.risk_band)}`}
      >
        {row.risk_band || "unknown"}
      </span>
    ),
  },
  {
    key: "urgency",
    header: "Service urgency",
    render: (row) => {
      const urgency = row.recommended_service_window?.urgency ?? "routine";
      return (
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${urgencyBadgeClass(urgency)}`}
        >
          {readableKey(urgency)}
        </span>
      );
    },
  },
  {
    key: "signals",
    header: "Signals",
    render: (row) => {
      const count = Array.isArray(row.contributing_signals)
        ? row.contributing_signals.length
        : 0;
      return (
        <div>
          <div className="font-medium">{count}</div>
          <div className="text-xs text-muted-foreground">
            risk score {row.predicted_failure_risk_score}
          </div>
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
    key: "cmms_action",
    header: "CMMS",
    render: (row) => <CreateWorkOrderFromPredictionButton row={row} />,
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
// Top tier — device registry.
// ---------------------------------------------------------------------------
type DeviceUpsertPayload = {
  device_code: string;
  device_type: string;
  manufacturer?: string | null;
  model?: string | null;
  serial_number?: string | null;
  location?: string | null;
  installed_at?: string | null;
  warranty_expires_on?: string | null;
  usage_hours?: number;
  fault_events_last_90d?: number;
  status?: string;
};

function DeviceRegistrySection() {
  const queryClient = useQueryClient();

  const devices = useQuery({
    queryKey: ["clinical-ai", "biomed_device_maintenance", "devices"],
    queryFn: () =>
      listClinicalAi(DEVICES_PATH, {}) as Promise<DeviceListResult & { count: number }>,
  });

  const [deviceCode, setDeviceCode] = useState("");
  const [deviceType, setDeviceType] = useState<string>(DEVICE_TYPES[0]);
  const [manufacturer, setManufacturer] = useState("");
  const [location, setLocation] = useState("");
  const [usageHours, setUsageHours] = useState("");
  const [faultEvents, setFaultEvents] = useState("");
  const [warrantyExpiresOn, setWarrantyExpiresOn] = useState("");
  const [status, setStatus] = useState<string>(DEVICE_STATUSES[0]);

  const upsert = useMutation({
    mutationFn: (payload: DeviceUpsertPayload) =>
      evaluateClinicalAi(DEVICES_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Device saved");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_device_maintenance", "devices"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_device_maintenance"],
      });
      setDeviceCode("");
      setManufacturer("");
      setLocation("");
      setUsageHours("");
      setFaultEvents("");
      setWarrantyExpiresOn("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save device"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = deviceCode.trim();
    if (!code) {
      toast.error("device_code is required");
      return;
    }
    const payload: DeviceUpsertPayload = {
      device_code: code,
      device_type: deviceType,
      manufacturer: manufacturer.trim() || null,
      location: location.trim() || null,
      warranty_expires_on: warrantyExpiresOn || null,
      status,
    };
    const usageRaw = usageHours.trim();
    if (usageRaw) {
      const parsed = Number.parseFloat(usageRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("usage_hours must be a non-negative number");
        return;
      }
      payload.usage_hours = parsed;
    }
    const faultsRaw = faultEvents.trim();
    if (faultsRaw) {
      const parsed = Number.parseInt(faultsRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("fault count must be a non-negative integer");
        return;
      }
      payload.fault_events_last_90d = parsed;
    }
    upsert.mutate(payload);
  };

  const rows = devices.data?.devices ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Biomedical Device Registry</h3>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="mb-2 text-sm font-medium">Upsert device</div>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Device code</span>
            <input
              value={deviceCode}
              onChange={(event) => setDeviceCode(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. VENT-014"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Device type</span>
            <select
              value={deviceType}
              onChange={(event) => setDeviceType(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {DEVICE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Manufacturer</span>
            <input
              value={manufacturer}
              onChange={(event) => setManufacturer(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Location</span>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="ward / room"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Usage hours</span>
            <input
              value={usageHours}
              onChange={(event) => setUsageHours(event.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Fault count (90d)</span>
            <input
              value={faultEvents}
              onChange={(event) => setFaultEvents(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Warranty expires</span>
            <input
              type="date"
              value={warrantyExpiresOn}
              onChange={(event) => setWarrantyExpiresOn(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {DEVICE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {readableKey(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="submit"
            disabled={upsert.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {upsert.isPending ? "Saving..." : "Save device"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Device code
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Location
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Usage hours
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Fault count
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Warranty
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {devices.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  Loading...
                </td>
              </tr>
            ) : devices.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-700"
                  colSpan={6}
                >
                  {(devices.error as Error | undefined)?.message ??
                    "Failed to load devices"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={6}
                >
                  No devices on file
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">
                    {row.device_code}
                  </td>
                  <td className="px-4 py-3">{readableKey(row.device_type)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.location ?? "-"}
                  </td>
                  <td className="px-4 py-3">{row.usage_hours}</td>
                  <td className="px-4 py-3">{row.fault_events_last_90d}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.warranty_expires_on)}
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
// Bottom tier — evaluate form + prediction review queue.
// ---------------------------------------------------------------------------
function MaintenanceEvaluateForm() {
  const queryClient = useQueryClient();
  const [deviceCode, setDeviceCode] = useState("");
  const [deviceType, setDeviceType] = useState<string>("");

  const evaluate = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      const code = deviceCode.trim();
      if (!code) {
        throw new Error("device_code is required");
      }
      body.device_code = code;
      return evaluateClinicalAi(EVALUATE_PATH, body);
    },
    onSuccess: () => {
      toast.success("Maintenance risk evaluated");
      setDeviceCode("");
      setDeviceType("");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_device_maintenance"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Evaluation failed"),
  });

  const canSubmit = deviceCode.trim().length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        evaluate.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-2 text-sm font-medium">Evaluate device maintenance risk</div>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Device code</span>
          <input
            value={deviceCode}
            onChange={(event) => setDeviceCode(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="e.g. VENT-014"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Device type (filter hint)</span>
          <select
            value={deviceType}
            onChange={(event) => setDeviceType(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="">Any</option>
            {DEVICE_TYPE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={evaluate.isPending || !canSubmit}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {evaluate.isPending ? "Evaluating..." : "Evaluate"}
        </button>
      </div>
    </form>
  );
}

function CmmsBoardSection() {
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: ["clinical-ai", "biomed_cmms", "board"],
    queryFn: () =>
      listClinicalAi(`${CMMS_PATH}/board`, {}) as Promise<CmmsBoardResult & { count: number }>,
  });

  const materialize = useMutation({
    mutationFn: () =>
      evaluateClinicalAi(`${CMMS_PATH}/work-orders/materialize-due`, {}),
    onSuccess: () => {
      toast.success("Due schedules checked");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_cmms"],
      });
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "biomed_device_maintenance"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to materialize schedules"),
  });

  const stats = board.data?.stats ?? {};
  const workOrders = board.data?.work_orders ?? [];
  const devices = board.data?.devices ?? [];
  const statCards: CmmsStatCard[] = [
    {
      label: "Active WOs",
      value: stats.active_work_order_count,
      Icon: Wrench,
    },
    {
      label: "SLA breaches",
      value: stats.sla_breach_count,
      Icon: ClipboardCheck,
    },
    {
      label: "Calibration due",
      value: stats.expired_or_failed_count,
      Icon: FileCheck2,
    },
    {
      label: "Downtime 30d",
      value: stats.downtime_minutes_30d,
      Icon: Cpu,
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">CMMS Operations</h3>
        </div>
        <button
          type="button"
          disabled={materialize.isPending}
          onClick={() => materialize.mutate()}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <RefreshCcw className="h-4 w-4" />
          {materialize.isPending ? "Checking..." : "Check Due Schedules"}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {statCards.map(({ label, value, Icon }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
            <div className="mt-1 text-xl font-semibold">{statValue(value)}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Work order</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Device</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Priority</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">SLA</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.isLoading ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={5}>
                    Loading...
                  </td>
                </tr>
              ) : board.isError ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-red-700" colSpan={5}>
                    {(board.error as Error | undefined)?.message ?? "Failed to load CMMS board"}
                  </td>
                </tr>
              ) : workOrders.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={5}>
                    No active biomedical work orders
                  </td>
                </tr>
              ) : (
                workOrders.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{row.work_order_number}</div>
                      <div className="text-xs text-muted-foreground">{readableKey(row.kind)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{row.device_code ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.device_type ? readableKey(row.device_type) : "-"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${workOrderPriorityClass(row.priority)}`}>
                        {readableKey(row.priority)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.sla_breached ? "Breached" : fmt(row.sla_due_at)}
                    </td>
                    <td className="px-4 py-3">{readableKey(row.status)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Device</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Next service</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">AMC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {devices.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={3}>
                    No device schedule rows
                  </td>
                </tr>
              ) : (
                devices.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{row.device_code}</div>
                      <div className="text-xs text-muted-foreground">{row.location ?? readableKey(row.device_type)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {fmt(row.next_scheduled_maintenance_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.amc_vendor ? `${row.amc_vendor} / ${fmt(row.amc_expires_on)}` : "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function BiomedDeviceMaintenancePanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Biomedical Device Maintenance</h2>
      </div>

      <DeviceRegistrySection />

      <CmmsBoardSection />

      <ClinicalAIReviewQueue<PredictionRow, MaintenanceDecision>
        title="Maintenance Predictions"
        moduleKey="biomed_device_maintenance"
        icon={<Cpu className="h-4 w-4" />}
        description="Decision-support only. Biomedical staff confirm every maintenance action — the service never dispatches technicians automatically."
        listFn={(params) => listClinicalAi(PREDICTIONS_PATH, params)}
        rowsKey="predictions"
        decideFn={(id, decision, note) =>
          decideClinicalAi(PREDICTIONS_PATH, id, decision, note)
        }
        filters={PREDICTION_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={PREDICTION_COLUMNS}
        decideActions={PREDICTION_DECIDE_ACTIONS}
        evaluateForm={<MaintenanceEvaluateForm />}
        emptyState="No maintenance predictions pending review"
      />
    </section>
  );
}
