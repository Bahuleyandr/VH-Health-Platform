"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Beaker,
  ClipboardCheck,
  CloudDownload,
  DollarSign,
  FlaskConical,
  Heart,
  Image,
  Microscope,
  PlayCircle,
  Receipt,
  Stethoscope,
  TrendingUp,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  acknowledgeVirtualWardEscalation,
  concludePromptExperiment,
  decideChargeCaptureAudit,
  decideImagingFinding,
  decidePolypharmacyReview,
  decideRcaDraft,
  decideTrialMatch,
  listCanaryRuns,
  listChargeCaptureAudits,
  listDeteriorationSnapshots,
  listImagingFindings,
  listPolypharmacyReviews,
  listPriorAuthorizations,
  listPromptExperiments,
  listRcaDrafts,
  listTrialMatches,
  listTrialSyncRuns,
  listVirtualWardEnrollments,
  listVirtualWardEscalations,
  recordPriorAuthPayerDecision,
  resolveVirtualWardEscalation,
  runCanary,
  submitPriorAuthorization,
  triggerTrialCatalogSync,
  type CanaryRunSummary,
  type ChargeCaptureAudit,
  type DeteriorationBand,
  type DeteriorationSnapshot,
  type ImagingFinding,
  type ImagingSeverity,
  type PolypharmacyReview,
  type PriorAuthRequest,
  type PromptExperiment,
  type RcaDraftSummary,
  type TrialMatch,
  type TrialSyncRun,
  type VirtualWardEnrollment,
  type VirtualWardEscalation,
  type VirtualWardSeverity,
} from "@/lib/api/emr";

function fmt(value?: string | null) {
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

function fmtMoneyMinor(value?: number | null) {
  if (value == null) return "-";
  return `₹${(Number(value) / 100).toLocaleString("en-IN")}`;
}

function severityBadgeClass(severity: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

// ---------------------------------------------------------------------------
// Prompt A/B Experiments
// ---------------------------------------------------------------------------
export function PromptExperimentsPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("running");
  const experiments = useQuery({
    queryKey: ["clinical-ai", "experiments", statusFilter],
    queryFn: () => listPromptExperiments(statusFilter || undefined),
  });
  const conclude = useMutation({
    mutationFn: ({ id, winner }: { id: number; winner?: "A" | "B" }) =>
      concludePromptExperiment(id, winner),
    onSuccess: () => {
      toast.success("Experiment concluded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "experiments"] });
    },
    onError: (err: Error) => toast.error(err.message || "Conclude failed"),
  });
  const rows: PromptExperiment[] = experiments.data?.experiments ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Prompt Experiments (A/B)</h2>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="running">Running</option>
          <option value="concluded">Concluded</option>
          <option value="paused">Paused</option>
          <option value="draft">Draft</option>
          <option value="">All</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Traffic-split between two candidate prompts per module. Winner hint fires at +10pp acceptance with &ge;20 samples each arm.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Split</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No experiments in this bucket
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.module_key}</td>
                  <td className="px-4 py-3">{row.name}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {Math.round(Number(row.traffic_split_a) * 100)}% / {100 - Math.round(Number(row.traffic_split_a) * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.status === "running" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {row.status}
                    </span>
                    {row.winning_variant ? (
                      <span className="ml-2 text-xs text-muted-foreground">winner: {row.winning_variant}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.started_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.status === "running" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => conclude.mutate({ id: row.id, winner: "A" })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ship A
                        </button>
                        <button
                          onClick={() => conclude.mutate({ id: row.id, winner: "B" })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ship B
                        </button>
                        <button
                          onClick={() => conclude.mutate({ id: row.id })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Conclude
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
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
// Drift Canary
// ---------------------------------------------------------------------------
export function DriftCanaryPanel() {
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ["clinical-ai", "canary", "runs"],
    queryFn: () => listCanaryRuns(),
  });
  const run = useMutation({
    mutationFn: () => runCanary(),
    onSuccess: (result) => {
      if (result.drift_detected) {
        toast.error(`Drift detected — ${result.pass_count}/${result.total_cases} cases passed`);
      } else {
        toast.success(`Canary clean — ${result.pass_count}/${result.total_cases} cases passed`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "canary", "runs"] });
    },
    onError: (err: Error) => toast.error(err.message || "Canary run failed"),
  });
  const rows: CanaryRunSummary[] = runs.data?.runs ?? [];
  const latest = rows[0];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Model Drift Canary</h2>
        </div>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {run.isPending ? "Running…" : "Run Canary"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sealed synthetic test set; alerts when pass-rate drops &ge;10pp vs the last good baseline.
      </p>
      {latest?.drift_detected ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <strong>Drift detected</strong> on the latest run — {latest.pass_count} of {latest.total_cases} cases passed. Review prompts or providers.
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scope</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Cases</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pass / Fail</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Drift</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No runs yet — configure canary cases via POST /admin/clinical-ai/canary/cases then run.
                </td>
              </tr>
            ) : (
              rows.slice(0, 20).map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-xs">{row.run_scope}</td>
                  <td className="px-4 py-3">{row.total_cases}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.pass_count} pass / {row.fail_count} fail
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.drift_detected ? "bg-red-100 text-red-800 border-red-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
                      {row.drift_detected ? "drift" : "clean"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.started_at)}</td>
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
// Charge Capture Audits
// ---------------------------------------------------------------------------
export function ChargeCapturePanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const audits = useQuery({
    queryKey: ["clinical-ai", "charge-capture", decisionFilter],
    queryFn: () => listChargeCaptureAudits(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "captured" | "rejected" }) =>
      decideChargeCaptureAudit(id, decision),
    onSuccess: () => {
      toast.success("Audit decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "charge-capture"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: ChargeCaptureAudit[] = audits.data?.audits ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Charge Capture Audits</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="captured">Captured</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Missed codes</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Est revenue</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scanned</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No audits
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">#{row.admission_id}</td>
                  <td className="px-4 py-3">
                    {row.missed_codes.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {row.missed_codes.slice(0, 4).map((c, idx) => (
                          <li key={idx}><span className="font-mono">{c.code}</span> — {c.description}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">{fmtMoneyMinor(row.estimated_revenue_minor)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scanned_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "captured" })}
                          disabled={decide.isPending || row.missed_codes.length === 0}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Capture
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.reviewer_decision}</span>
                    )}
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
// Deterioration Early Warning
// ---------------------------------------------------------------------------
function deteriorationBandClass(band: string) {
  if (band === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (band === "concerning") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function DeteriorationPanel() {
  const [bandFilter, setBandFilter] = useState<DeteriorationBand | "">("concerning");
  const snapshots = useQuery({
    queryKey: ["clinical-ai", "deterioration", bandFilter],
    queryFn: () => listDeteriorationSnapshots(bandFilter || undefined),
  });
  const rows: DeteriorationSnapshot[] = snapshots.data?.snapshots ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Deterioration Early Warning</h2>
        </div>
        <select
          value={bandFilter}
          onChange={(event) => setBandFilter(event.target.value as DeteriorationBand | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="critical">Critical only</option>
          <option value="concerning">Concerning + critical</option>
          <option value="watch">Watch</option>
          <option value="stable">Stable</option>
          <option value="">All bands</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Composite score (NEWS2 + trend + lab). Decision support; never silences a rule-based alarm.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Band</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Components</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top rec</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No snapshots in this band
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const topRec = row.recommendations?.[0];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-xs">{row.patient_uid}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${deteriorationBandClass(row.band)}`}>
                        {row.band}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{Number(row.score).toFixed(0)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      news {Number(row.news2_component).toFixed(0)} · trend {Number(row.trend_component).toFixed(0)} · lab {Number(row.lab_component).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-xs">{topRec?.message ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Polypharmacy Reviews
// ---------------------------------------------------------------------------
export function PolypharmacyPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const reviews = useQuery({
    queryKey: ["clinical-ai", "polypharmacy", decisionFilter],
    queryFn: () => listPolypharmacyReviews(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "acknowledged" | "overridden" | "prescription_changed"; note?: string }) =>
      decidePolypharmacyReview(id, decision, note),
    onSuccess: () => {
      toast.success("Review decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "polypharmacy"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: PolypharmacyReview[] = reviews.data?.reviews ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Polypharmacy Reviews</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="overridden">Overridden</option>
          <option value="prescription_changed">Prescription changed</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Rule findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">AI findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scored</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No reviews
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-xs">{row.patient_uid}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.combined_severity)}`}>
                      {row.combined_severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{row.rule_findings.length} finding(s)</div>
                    {row.rule_findings[0] ? (
                      <div className="text-xs">{row.rule_findings[0].code}: {row.rule_findings[0].message.slice(0, 80)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{row.ai_findings.length} finding(s)</div>
                    {row.ai_findings[0] ? (
                      <div className="text-xs">{row.ai_findings[0].code}: {row.ai_findings[0].message.slice(0, 80)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "acknowledged" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "prescription_changed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Rx changed
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Override reason (clinical justification)") ?? undefined;
                            decide.mutate({ id: row.id, decision: "overridden", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Override
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.reviewer_decision}</span>
                    )}
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
// Clinical Trial Catalog Sync (ClinicalTrials.gov v2)
// ---------------------------------------------------------------------------
export function TrialCatalogSyncPanel() {
  const queryClient = useQueryClient();
  const [conditions, setConditions] = useState("");
  const [location, setLocation] = useState("");
  const runs = useQuery({
    queryKey: ["clinical-ai", "trial-sync-runs"],
    queryFn: () => listTrialSyncRuns(),
  });
  const sync = useMutation({
    mutationFn: () => {
      const conditionList = conditions
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      return triggerTrialCatalogSync({
        conditions: conditionList.length ? conditionList : undefined,
        location: location.trim() || undefined,
        max_results: 100,
      });
    },
    onSuccess: (result) => {
      if (result.status === "failed") {
        toast.error(`Sync failed: ${result.error_message ?? "unknown error"}`);
      } else {
        toast.success(`Synced ${result.upserted_count} of ${result.fetched_count} trials`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trial-sync-runs"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trials"] });
    },
    onError: (err: Error) => toast.error(err.message || "Sync failed"),
  });
  const rows: TrialSyncRun[] = runs.data?.runs ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CloudDownload className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Trial Catalog Sync</h2>
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <CloudDownload className="h-4 w-4" />
          {sync.isPending ? "Syncing…" : "Sync ClinicalTrials.gov"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Pulls recruiting trials from the public registry. Blank conditions + location auto-seed from the tenant&apos;s most-common active diagnoses (India default for DPDP tenants).
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Conditions (comma-separated, optional)
          <input
            value={conditions}
            onChange={(event) => setConditions(event.target.value)}
            placeholder="diabetes mellitus, pneumonia"
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Location (country or city, optional)
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="India"
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Conditions</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Location</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Fetched</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Upserted</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={7}>
                  No sync history yet — run the first sync to populate.
                </td>
              </tr>
            ) : (
              rows.slice(0, 10).map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.source}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.query_conditions.slice(0, 3).join(", ")}
                    {row.query_conditions.length > 3 ? ` +${row.query_conditions.length - 3}` : ""}
                  </td>
                  <td className="px-4 py-3 text-xs">{row.query_location ?? "-"}</td>
                  <td className="px-4 py-3">{row.fetched_count}</td>
                  <td className="px-4 py-3">{row.upserted_count}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.status === "completed" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : row.status === "failed" ? "bg-red-100 text-red-800 border-red-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {row.status}
                    </span>
                    {row.error_message ? (
                      <div className="mt-1 text-xs text-red-700">{row.error_message.slice(0, 120)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.started_at)}</td>
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
// Clinical Trial Matches
// ---------------------------------------------------------------------------
export function TrialMatchesPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const matches = useQuery({
    queryKey: ["clinical-ai", "trials", decisionFilter],
    queryFn: () => listTrialMatches(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "offered" | "enrolled" | "declined" | "ineligible" }) =>
      decideTrialMatch(id, decision),
    onSuccess: () => {
      toast.success("Match decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trials"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: TrialMatch[] = matches.data?.matches ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Microscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Clinical Trial Matches</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="offered">Offered</option>
          <option value="enrolled">Enrolled</option>
          <option value="declined">Declined</option>
          <option value="ineligible">Ineligible</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Trial</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Match</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scored</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No matches. Upload trials to /admin/clinical-ai/trials/catalog then POST /trials/match/:patientUid.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.title}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.nct_id}{row.phase ? ` · ${row.phase}` : ""}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold">{Number(row.match_score).toFixed(0)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.coordinator_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "offered" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Offer
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "ineligible" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Ineligible
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.coordinator_decision}</span>
                    )}
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
// RCA Drafts
// ---------------------------------------------------------------------------
export function RcaDraftsPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const drafts = useQuery({
    queryKey: ["clinical-ai", "rca", decisionFilter],
    queryFn: () => listRcaDrafts(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "accepted" | "revised" | "rejected"; note?: string }) =>
      decideRcaDraft(id, decision, note),
    onSuccess: () => {
      toast.success("RCA decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "rca"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: RcaDraftSummary[] = drafts.data?.drafts ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Mortality / RCA Drafts</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="revised">Revised</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Case type</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Decision</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No drafts. Trigger via POST /admin/clinical-ai/rca/:admissionId.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.case_type}</td>
                  <td className="px-4 py-3 font-mono text-xs">#{row.admission_id}</td>
                  <td className="px-4 py-3 text-xs">{row.reviewer_decision}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Revision note") ?? undefined;
                            decide.mutate({ id: row.id, decision: "revised", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Revise
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
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
// Prior Authorization
// ---------------------------------------------------------------------------
function priorAuthStatusClass(status: string) {
  if (status === "approved") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "denied") return "bg-red-100 text-red-800 border-red-200";
  if (status === "submitted") return "bg-blue-100 text-blue-800 border-blue-200";
  if (status === "withdrawn") return "bg-slate-100 text-slate-700 border-slate-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

export function PriorAuthorizationPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("draft");
  const auths = useQuery({
    queryKey: ["clinical-ai", "prior-auth", statusFilter],
    queryFn: () => listPriorAuthorizations(statusFilter || undefined),
  });
  const submit = useMutation({
    mutationFn: (id: number) => submitPriorAuthorization(id),
    onSuccess: () => {
      toast.success("Prior auth submitted to payer");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prior-auth"] });
    },
    onError: (err: Error) => toast.error(err.message || "Submit failed"),
  });
  const payerDecision = useMutation({
    mutationFn: ({ id, decision, reason }: { id: number; decision: "approved" | "denied" | "withdrawn"; reason?: string }) =>
      recordPriorAuthPayerDecision(id, decision, reason),
    onSuccess: () => {
      toast.success("Payer decision recorded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prior-auth"] });
    },
    onError: (err: Error) => toast.error(err.message || "Record failed"),
  });
  const rows: PriorAuthRequest[] = auths.data?.prior_auths ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Prior Authorization</h2>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="denied">Denied</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Payer</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Procedure</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Submitted</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Payer decision</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No prior-auth requests
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.payer_name}</div>
                    <div className="text-xs text-muted-foreground">{row.policy_number ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">{row.procedure_code}</div>
                    <div className="text-xs text-muted-foreground">{row.procedure_description ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorAuthStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.submitted_at)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.payer_decided_at ? (
                      <>
                        {fmt(row.payer_decided_at)}
                        {row.payer_decision_reason ? <div>{row.payer_decision_reason}</div> : null}
                      </>
                    ) : "-"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.status === "draft" ? (
                      <button
                        onClick={() => submit.mutate(row.id)}
                        disabled={submit.isPending}
                        className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        Submit
                      </button>
                    ) : row.status === "submitted" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => payerDecision.mutate({ id: row.id, decision: "approved" })}
                          disabled={payerDecision.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Approved
                        </button>
                        <button
                          onClick={() => {
                            const reason = window.prompt("Denial reason") ?? undefined;
                            payerDecision.mutate({ id: row.id, decision: "denied", reason });
                          }}
                          disabled={payerDecision.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Denied
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
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
// Imaging AI (radiology_ai_interpretation)
// ---------------------------------------------------------------------------
function imagingSeverityClass(severity: string) {
  if (severity === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (severity === "actionable") return "bg-orange-100 text-orange-800 border-orange-200";
  if (severity === "incidental") return "bg-amber-100 text-amber-800 border-amber-200";
  if (severity === "unreadable") return "bg-slate-200 text-slate-900 border-slate-300";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function ImagingAIPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [severityFilter, setSeverityFilter] = useState<ImagingSeverity | "">("");
  const findings = useQuery({
    queryKey: ["clinical-ai", "imaging", decisionFilter, severityFilter],
    queryFn: () =>
      listImagingFindings({
        decision: decisionFilter || undefined,
        severity: severityFilter || undefined,
      }),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "confirmed" | "revised" | "rejected" | "escalated"; note?: string }) =>
      decideImagingFinding(id, decision, note),
    onSuccess: () => {
      toast.success("Imaging finding decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "imaging"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: ImagingFinding[] = findings.data?.findings ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Imaging AI — Radiologist Queue</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="revised">Revised</option>
            <option value="rejected">Rejected</option>
            <option value="escalated">Escalated</option>
            <option value="">All</option>
          </select>
          <select
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as ImagingSeverity | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">Any severity</option>
            <option value="critical">Critical</option>
            <option value="actionable">Actionable</option>
            <option value="incidental">Incidental</option>
            <option value="normal">Normal</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        External-model inference ingested via POST /admin/clinical-ai/imaging/inference. Critical findings sort to the top. Radiologist decision is authoritative.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Study</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Confidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No imaging findings. Register studies via POST /imaging/studies then ingest inference via POST /imaging/inference.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${imagingSeverityClass(row.overall_severity)}`}>
                      {row.overall_severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.modality} · {row.body_part ?? "-"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.study_instance_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid ?? ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    {row.findings.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {row.findings.slice(0, 3).map((f, idx) => (
                          <li key={idx}>
                            <span className="font-mono">{f.label}</span> — {(f.confidence * 100).toFixed(0)}%
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold">{row.confidence_pct ?? "-"}%</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.provider}{row.model ? ` · ${row.model}` : ""}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.radiologist_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "confirmed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Revision note") ?? undefined;
                            decide.mutate({ id: row.id, decision: "revised", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Revise
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "escalated" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Escalate
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.radiologist_decision}</span>
                    )}
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
// Virtual ward
// ---------------------------------------------------------------------------
function virtualWardSeverityClass(severity: string) {
  if (severity === "red") return "bg-red-200 text-red-900 border-red-300";
  if (severity === "amber") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function VirtualWardPanel() {
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<VirtualWardSeverity | "">("red");
  const escalations = useQuery({
    queryKey: ["clinical-ai", "virtual-ward", severityFilter],
    queryFn: () => listVirtualWardEscalations(severityFilter || undefined),
    refetchInterval: 60_000,
  });
  const enrollments = useQuery({
    queryKey: ["clinical-ai", "virtual-ward", "enrollments"],
    queryFn: () => listVirtualWardEnrollments(),
  });
  const ack = useMutation({
    mutationFn: (id: number) => acknowledgeVirtualWardEscalation(id),
    onSuccess: () => {
      toast.success("Escalation acknowledged");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "virtual-ward"] });
    },
    onError: (err: Error) => toast.error(err.message || "Acknowledge failed"),
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolution, note }: { id: number; resolution: string; note?: string }) =>
      resolveVirtualWardEscalation(id, resolution, note),
    onSuccess: () => {
      toast.success("Escalation resolved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "virtual-ward"] });
    },
    onError: (err: Error) => toast.error(err.message || "Resolve failed"),
  });
  const escRows: VirtualWardEscalation[] = escalations.data?.escalations ?? [];
  const enrollRows: VirtualWardEnrollment[] = enrollments.data?.enrollments ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Virtual Ward — Open Escalations</h2>
        </div>
        <select
          value={severityFilter}
          onChange={(event) => setSeverityFilter(event.target.value as VirtualWardSeverity | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="red">Red only</option>
          <option value="amber">Amber only</option>
          <option value="">All open</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Post-discharge check-ins triaged green/amber/red. Red submissions mark the enrollment as escalated. Care manager acknowledges + resolves.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Active enrollments</div>
          <div className="mt-1 text-2xl font-semibold">{enrollRows.filter((e) => e.status === "active").length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Escalated enrollments</div>
          <div className="mt-1 text-2xl font-semibold text-red-700">{enrollRows.filter((e) => e.status === "escalated").length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Open escalations</div>
          <div className="mt-1 text-2xl font-semibold">{escRows.length}</div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pathway</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {escRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No open escalations in this bucket
                </td>
              </tr>
            ) : (
              escRows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${virtualWardSeverityClass(row.severity)}`}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.pathway ?? "-"}</td>
                  <td className="px-4 py-3 max-w-md text-xs">{row.reason}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {!row.acknowledged_at ? (
                      <button
                        onClick={() => ack.mutate(row.id)}
                        disabled={ack.isPending}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    ) : !row.resolved_at ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => resolve.mutate({ id: row.id, resolution: "call_completed" })}
                          disabled={resolve.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Call done
                        </button>
                        <button
                          onClick={() => resolve.mutate({ id: row.id, resolution: "referred_to_ed" })}
                          disabled={resolve.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Refer ED
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Resolution note (optional)") ?? undefined;
                            resolve.mutate({ id: row.id, resolution: "resolved_remotely", note });
                          }}
                          disabled={resolve.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Resolved
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.resolution}</span>
                    )}
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

// Re-export a single header for the section in page.tsx.
export function AIExpansionHeader() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="h-4 w-4" />
        Clinical AI expansion — decision-support only
      </div>
      <p className="mt-1">
        The panels below surface AI-generated decisions for human review. Every action below records a tenant-scoped audit entry.
        These modules never auto-action — clinicians, coders, and coordinators decide.
      </p>
    </div>
  );
}

export { Activity }; // keep the icon export so page.tsx tree-shakes cleanly
