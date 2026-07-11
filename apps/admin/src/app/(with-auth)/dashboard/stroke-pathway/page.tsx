"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
} from "lucide-react";

import { fetchAdminAPI } from "@/lib/api";

type NihssSummary = {
  id: number;
  total_score: number;
  signoff_status: string;
  assessed_at?: string | null;
  nihss_source?: string | null;
  nihss_version?: string | null;
};

type ThrombolysisSummary = {
  id: number;
  decision_status: string;
  decided_at?: string | null;
  protocol_source?: string | null;
  protocol_version?: string | null;
};

type SlaInstance = {
  id: string;
  rule_code: string;
  status: string;
  started_at?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
};

type StrokeActivation = {
  id: number;
  patient_uid: string;
  activation_source: string;
  status: string;
  activated_at: string;
  door_time_at?: string | null;
  radiology_context_tags?: string[];
  radiology_signal_codes?: string[];
  latest_nihss?: NihssSummary | null;
  latest_thrombolysis_decision?: ThrombolysisSummary | null;
  sla_instances?: SlaInstance[];
};

type ActivationPayload = {
  activations?: StrokeActivation[];
  count?: number;
};

function fmtDateTime(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function statusClass(value?: string | null) {
  switch ((value || "").toLowerCase()) {
    case "active":
      return "border-red-200 bg-red-50 text-red-700";
    case "imaging":
      return "border-blue-200 bg-blue-50 text-blue-700";
    case "decision_pending":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "treated":
      return "border-green-200 bg-green-50 text-green-700";
    case "completed":
      return "border-green-200 bg-green-50 text-green-700";
    case "breached":
      return "border-red-200 bg-red-50 text-red-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function timerName(ruleCode?: string | null) {
  if (ruleCode === "stroke_door_to_ct") return "Door-to-CT";
  if (ruleCode === "stroke_door_to_needle") return "Door-to-needle";
  return ruleCode || "Timer";
}

function StatusPill({ value }: { value?: string | null }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass(value)}`}>
      {(value || "-").replaceAll("_", " ")}
    </span>
  );
}

function ActivationCard({ activation }: { activation: StrokeActivation }) {
  const slas = activation.sla_instances ?? [];
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <h2 className="text-base font-semibold">Stroke activation #{activation.id}</h2>
            <StatusPill value={activation.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{activation.patient_uid}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Activated {fmtDateTime(activation.activated_at)} from {activation.activation_source}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(activation.radiology_context_tags ?? []).map((tag) => (
            <span key={tag} className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
              {tag}
            </span>
          ))}
          {(activation.radiology_signal_codes ?? []).map((code) => (
            <span key={code} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700">
              {code}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Activity className="h-4 w-4 text-blue-600" />
            NIHSS
          </div>
          <p className="mt-2 text-2xl font-semibold">
            {activation.latest_nihss?.total_score ?? "-"}
          </p>
          <p className="text-xs text-muted-foreground">
            {activation.latest_nihss ? activation.latest_nihss.signoff_status : "Pending"}
          </p>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Thrombolysis
          </div>
          <p className="mt-2 text-lg font-semibold">
            {activation.latest_thrombolysis_decision?.decision_status?.replaceAll("_", " ") ?? "Pending"}
          </p>
          <p className="text-xs text-muted-foreground">
            {fmtDateTime(activation.latest_thrombolysis_decision?.decided_at)}
          </p>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4 text-amber-600" />
            Timers
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {slas.length === 0 && <span className="text-sm text-muted-foreground">No timers</span>}
            {slas.map((sla) => (
              <StatusPill key={sla.id} value={`${timerName(sla.rule_code)} ${sla.status}`} />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function StrokePathwayPage() {
  const query = useQuery({
    queryKey: ["stroke-pathway", "activations"],
    queryFn: () => fetchAdminAPI<ActivationPayload>("/stroke-pathway/activations?limit=50"),
    refetchInterval: 30000,
  });

  const activations = query.data?.activations ?? [];

  return (
    <main className="space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">Stroke Pathway</h1>
          <p className="text-sm text-muted-foreground">
            Activation status, NIHSS sign-off, thrombolysis decisions, and pathway timers.
          </p>
        </div>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {query.isLoading && (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          Loading stroke activations...
        </div>
      )}
      {query.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {query.error instanceof Error ? query.error.message : "Failed to load stroke pathway"}
        </div>
      )}
      {!query.isLoading && !query.isError && activations.length === 0 && (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          No active stroke pathways
        </div>
      )}
      <section className="grid gap-3">
        {activations.map((activation) => (
          <ActivationCard key={activation.id} activation={activation} />
        ))}
      </section>
    </main>
  );
}
