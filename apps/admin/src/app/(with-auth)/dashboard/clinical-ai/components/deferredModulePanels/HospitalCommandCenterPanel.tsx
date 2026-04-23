"use client";

// Phase-2 clinical-AI panel. Tracker row 21 — hospital_command_center.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (4372/4386).
// Service: apps/backend/src/services/ai/hospitalCommandCenterService.js
//          (listCommandSnapshots / decideCommandSnapshot).

import { Radar } from "lucide-react";

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
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

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

export default function HospitalCommandCenterPanel() {
  return (
    <ClinicalAIReviewQueue<CommandSnapshotRow, CommandSnapshotDecision>
      title="Hospital Command Center"
      moduleKey="hospital_command_center"
      icon={<Radar className="h-4 w-4" />}
      description="Per-department operational tier rollups for duty-officer review. Decision support only."
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
      emptyState="No command center snapshots pending review"
    />
  );
}
