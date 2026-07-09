"use client";

// Phase-2 clinical-AI panel. Tracker row 21 — hospital_command_center.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4372/4386).
// Service: apps/backend/src/services/ai/hospitalCommandCenterService.js
//          (listCommandSnapshots / decideCommandSnapshot).

import { useQuery } from "@tanstack/react-query";
import { BedDouble, Clock3, LockKeyhole, Radar, RefreshCw, ShieldCheck } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
  type KpiSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
} from "@/lib/api/clinicalAiGeneric";
import {
  getCommandCenterSnapshots,
  type CommandCenterCensusLosBridge,
} from "@/lib/api/clinicalAiModules";

// ---------------------------------------------------------------------------
// Row shape — `normalizeSnapshotRow` output. `department_status` is a jsonb
// record keyed by department name with a `tier` field per value.
// ---------------------------------------------------------------------------
type CommandSnapshotRow = {
  id: number;
  snapshot_at: string | null;
  command_status: string;
  overall_score: number;
  department_status: unknown;
  reviewer_decision: string;
  created_at: string | null;
};

// Backend accepts: accepted, deferred, rejected, edited.
// See FINAL_DECISIONS in hospitalCommandCenterService.js.
type CommandSnapshotDecision = "accepted" | "deferred" | "rejected" | "edited";

const COMMAND_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "watch", label: "Watch" },
  { value: "elevated", label: "Elevated" },
  { value: "crisis", label: "Crisis" },
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
  {
    key: "command_status",
    label: "Status",
    kind: "select",
    options: COMMAND_STATUS_OPTIONS,
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

function commandStatusBadgeClass(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "crisis") return "bg-red-100 text-red-800 border-red-200";
  if (s === "elevated") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  if (s === "normal") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

// Pull the per-department tier out of a `department_status` jsonb blob. The
// blob is shaped like `{ bed: { tier: "watch", ... }, ed: { tier: "crisis" } }`
// in the service. Some legacy rows may store scalar strings, so we normalise.
function deptTier(entry: unknown): string {
  if (!entry) return "unknown";
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") {
    const tier = (entry as Record<string, unknown>).tier;
    return typeof tier === "string" ? tier : "unknown";
  }
  return "unknown";
}

function criticalDepartmentNames(status: unknown): string[] {
  if (!status || typeof status !== "object") return [];
  const out: string[] = [];
  for (const [name, raw] of Object.entries(status as Record<string, unknown>)) {
    const tier = deptTier(raw).toLowerCase();
    if (tier === "crisis" || tier === "elevated") {
      out.push(readableKey(name));
    }
  }
  return out;
}

const KPIS: KpiSpec<CommandSnapshotRow>[] = [
  { label: "Total", compute: (rows) => rows.length },
  {
    label: "Crisis",
    compute: (rows) =>
      rows.filter((row) => (row.command_status || "").toLowerCase() === "crisis").length,
  },
  {
    label: "Elevated+",
    compute: (rows) =>
      rows.filter((row) =>
        ["elevated", "crisis"].includes((row.command_status || "").toLowerCase())
      ).length,
    helpText: "Elevated or crisis-tier snapshots",
  },
];

const COLUMNS: ColumnSpec<CommandSnapshotRow>[] = [
  {
    key: "snapshot_at",
    header: "Snapshot",
    render: (row) => (
      <span className="text-xs text-muted-foreground">
        {fmt(row.snapshot_at ?? row.created_at)}
      </span>
    ),
  },
  {
    key: "command_status",
    header: "Status",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${commandStatusBadgeClass(row.command_status)}`}
      >
        {row.command_status || "unknown"}
      </span>
    ),
  },
  {
    key: "overall_score",
    header: "Score",
    render: (row) => (row.overall_score ?? 0).toFixed(0),
  },
  {
    key: "critical_depts",
    header: "Critical depts",
    render: (row) => {
      const names = criticalDepartmentNames(row.department_status);
      if (!names.length) return <span className="text-xs text-muted-foreground">None</span>;
      return (
        <span className="text-xs">
          {names.join(", ")}
        </span>
      );
    },
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const DECIDE_ACTIONS: DecideAction<CommandSnapshotDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/command-center/snapshots";

function confidenceBadgeClass(value: string): string {
  const v = (value || "").toLowerCase();
  if (v === "high") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (v === "moderate") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function formatAge(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "Unknown";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function moduleLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function CensusLosBridgePanel() {
  const query = useQuery({
    queryKey: ["clinical-ai", "hospital_command_center", "census_los"],
    queryFn: () => getCommandCenterSnapshots({ limit: 1 }),
  });

  const bridge = query.data?.census_los as CommandCenterCensusLosBridge | undefined;
  const hidden = bridge?.hidden ?? false;
  const summary = bridge?.summary ?? null;
  const patients = bridge?.patients ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <BedDouble className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">Predictive Census/LOS</h3>
          {bridge ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium ${confidenceBadgeClass(bridge.confidence_band)}`}
            >
              {bridge.confidence_band}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card hover:bg-accent disabled:opacity-50"
          disabled={query.isFetching}
          aria-label="Refresh census LOS bridge"
          title="Refresh census LOS bridge"
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>

      {query.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {(query.error as Error | undefined)?.message || "Failed to load census/LOS forecast"}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          Loading census/LOS forecast...
        </div>
      ) : null}

      {bridge && hidden ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-medium">
            <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            Forecast hidden
          </div>
          <div className="mt-1">
            {bridge.hidden_reason === "stale_forecast"
              ? `Latest forecast is ${formatAge(bridge.age_minutes)} old; stale forecasts are hidden after ${bridge.freshness_threshold_minutes}m.`
              : "No current census/LOS forecast is available."}
          </div>
          <div className="mt-2 text-xs">
            Owner: {bridge.governance_owner_role}. Decision support only; review required before operational action.
          </div>
        </div>
      ) : null}

      {bridge && !hidden && summary ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">Admitted census</div>
              <div className="mt-1 text-xl font-semibold">{summary.admitted_count}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">Likely 24h discharges</div>
              <div className="mt-1 text-xl font-semibold">{summary.likely_discharges_24h}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">Likely 48h discharges</div>
              <div className="mt-1 text-xl font-semibold">{summary.likely_discharges_48h}</div>
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                Freshness
              </div>
              <div className="mt-1 text-xl font-semibold">{formatAge(bridge.age_minutes)}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Owner: {bridge.governance_owner_role}</span>
            <span>Window: {summary.forecast_window_hours}h</span>
            <span>Generated: {fmt(bridge.generated_at)}</span>
            {bridge.source_modules.map((source) => (
              <span key={source} className="rounded-full border border-border px-2 py-0.5">
                {moduleLabel(source)}
              </span>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Ward</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Bed</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">LOS remaining</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Flow signal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {patients.length === 0 ? (
                  <tr>
                    <td className="px-4 py-4 text-center text-sm text-muted-foreground" colSpan={4}>
                      No patient-level LOS rows in the latest forecast
                    </td>
                  </tr>
                ) : (
                  patients.slice(0, 8).map((patient, index) => (
                    <tr key={`${patient.admission_id ?? "admission"}-${index}`}>
                      <td className="px-4 py-2">{patient.ward || "-"}</td>
                      <td className="px-4 py-2">{patient.bed_number || "-"}</td>
                      <td className="px-4 py-2">
                        {patient.remaining_hours_estimate === null
                          ? "-"
                          : `${patient.remaining_hours_estimate}h`}
                      </td>
                      <td className="px-4 py-2">
                        {patient.likely_discharge_24h
                          ? "Likely 24h discharge"
                          : patient.likely_discharge_48h
                            ? "Likely 48h discharge"
                            : "Monitor"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default function HospitalCommandCenterPanel() {
  return (
    <div className="space-y-6">
      <CensusLosBridgePanel />
      <ClinicalAIReviewQueue<CommandSnapshotRow, CommandSnapshotDecision>
        title="Hospital Command Center"
        moduleKey="hospital_command_center"
        icon={<Radar className="h-4 w-4" />}
        description="Per-department operational tier rollups for duty-officer review. Decision support only."
        listFn={(params) => getCommandCenterSnapshots(params)}
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
        emptyState="No command center snapshots pending review"
      />
    </div>
  );
}
