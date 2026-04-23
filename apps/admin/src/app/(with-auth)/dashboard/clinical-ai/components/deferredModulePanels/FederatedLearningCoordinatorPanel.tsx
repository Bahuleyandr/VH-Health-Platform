"use client";

// Phase-2 clinical-AI panel. Tracker row 34 — federated_learning_coordinator.
// Two-tier module:
//   Top tier  — federation sites (list + upsert form + status/approval change)
//   Bottom    — federation rounds (record + list + decide via shared queue)
//
// Backend routes (apps/backend/src/routes/admin/clinicalAiRoutes.js):
//   POST  /admin/clinical-ai/federation/sites               upsertFederationSite
//   GET   /admin/clinical-ai/federation/sites               listFederationSites
//   PATCH /admin/clinical-ai/federation/sites/:id/status    changeSiteStatus
//   POST  /admin/clinical-ai/federation/rounds              recordFederationRound
//   GET   /admin/clinical-ai/federation/rounds              listFederationRounds
//   PATCH /admin/clinical-ai/federation/rounds/:id          decideFederationRound
// Service: apps/backend/src/services/ai/federatedLearningCoordinatorService.js

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, PlayCircle, Save, Settings2 } from "lucide-react";
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
  patchClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Reference data mirrors SITE_STATUSES / APPROVAL_STATES / AGGREGATION_METHODS
// / RECOMMENDATIONS in federatedLearningCoordinatorService.js.
// ---------------------------------------------------------------------------
const SITE_STATUSES = [
  "onboarding",
  "active",
  "paused",
  "withdrawn",
  "quarantined",
  "unknown",
] as const;

const APPROVAL_STATES = ["pending", "approved", "revoked", "rejected"] as const;

const AGGREGATION_METHODS = [
  "fed_avg",
  "fed_prox",
  "fed_sgd",
  "secure_avg",
  "differential_fed_avg",
  "unknown",
] as const;

const RECOMMENDATIONS = [
  "ready",
  "hold",
  "abort",
  "review_privacy",
  "no_action",
  "unknown",
] as const;

const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;

const MODULE_KEY = "federated_learning_coordinator";
const SITES_PATH = "/admin/clinical-ai/federation/sites";
const ROUNDS_PATH = "/admin/clinical-ai/federation/rounds";

type FederationRoundDecision = "accepted" | "deferred" | "rejected" | "edited";

type SiteStatus = (typeof SITE_STATUSES)[number];
type ApprovalStatus = (typeof APPROVAL_STATES)[number];

type FederationSiteRow = {
  id: number;
  site_key: string;
  display_name: string | null;
  region: string | null;
  contact: string | null;
  status: SiteStatus;
  dp_epsilon_budget: number | null;
  dp_epsilon_spent: number | null;
  min_cohort_size: number | null;
  last_seen_at: string | null;
  approval_status: ApprovalStatus;
  approval_note: string | null;
  approved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type FederationRoundRow = {
  id: number;
  round_key: string;
  model_key: string;
  aggregation_method: string;
  participant_site_count: number;
  min_participants: number;
  total_dp_epsilon_spent: number | null;
  cohort_total_size: number;
  cohort_min_site_size: number | null;
  data_drift_score: number | null;
  recommendation: string;
  severity: string;
  summary: string | null;
  reviewer_decision: string;
  created_at: string | null;
};

type FederationSiteListResult = {
  sites?: FederationSiteRow[];
  count?: number;
};

type SiteUpsertPayload = {
  site_key: string;
  display_name?: string | null;
  region?: string | null;
  contact?: string | null;
  dp_epsilon_budget?: number | null;
  dp_epsilon_spent?: number | null;
  min_cohort_size?: number | null;
  accepted_aggregation_methods?: string[] | null;
};

type SiteStatusChangePayload = {
  status: SiteStatus;
  approval_status?: ApprovalStatus | null;
  approval_note?: string | null;
};

type RoundRecordPayload = {
  round_key: string;
  model_key: string;
  aggregation_method: string;
  participant_site_count: number;
  min_participants: number;
  total_dp_epsilon_spent: number;
  total_dp_epsilon_budget: number;
  cohort_total_size: number;
  cohort_min_site_size: number | null;
  data_drift_score: number | null;
};

function toOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Bottom-tier: review queue for federation rounds.
// ---------------------------------------------------------------------------
const ROUND_FILTERS: FilterSpec[] = [
  { key: "round_key", label: "Round key", kind: "text", placeholder: "round key" },
  { key: "model_key", label: "Model key", kind: "text", placeholder: "model key" },
  {
    key: "recommendation",
    label: "Recommendation",
    kind: "select",
    options: RECOMMENDATIONS.map((value) => ({ value, label: readableKey(value) })),
  },
  {
    key: "severity",
    label: "Severity",
    kind: "select",
    options: SEVERITIES.map((value) => ({ value, label: readableKey(value) })),
  },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: [
      { value: "pending", label: "Pending" },
      { value: "accepted", label: "Accepted" },
      { value: "deferred", label: "Deferred" },
      { value: "rejected", label: "Rejected" },
      { value: "edited", label: "Edited" },
    ],
  },
];

const ROUND_COLUMNS: ColumnSpec<FederationRoundRow>[] = [
  {
    key: "round",
    header: "Round / Model",
    render: (row) => (
      <div>
        <div className="font-mono text-xs font-medium">{row.round_key}</div>
        <div className="text-xs text-muted-foreground">{row.model_key}</div>
      </div>
    ),
  },
  {
    key: "aggregation",
    header: "Aggregation",
    render: (row) => (
      <span className="font-mono text-xs">{readableKey(row.aggregation_method)}</span>
    ),
  },
  {
    key: "participants",
    header: "Sites",
    render: (row) => (
      <div>
        <div className="font-medium">{row.participant_site_count}</div>
        <div className="text-xs text-muted-foreground">min {row.min_participants}</div>
      </div>
    ),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => (
      <div>
        <div>{readableKey(row.recommendation)}</div>
        {row.summary ? (
          <div className="text-xs text-muted-foreground">{row.summary}</div>
        ) : null}
      </div>
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
    key: "drift",
    header: "Drift",
    render: (row) =>
      row.data_drift_score === null || row.data_drift_score === undefined
        ? "-"
        : row.data_drift_score.toFixed(3),
  },
  {
    key: "decision",
    header: "Review status",
    render: (row) => (
      <span className="text-xs">{readableKey(row.reviewer_decision)}</span>
    ),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const ROUND_DECIDE_ACTIONS: DecideAction<FederationRoundDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

// ---------------------------------------------------------------------------
// Top-tier: federation sites list + upsert + status change.
// ---------------------------------------------------------------------------
function FederationSitesSection() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [regionFilter, setRegionFilter] = useState<string>("");

  const sites = useQuery({
    queryKey: ["clinical-ai", MODULE_KEY, "sites", statusFilter, regionFilter],
    queryFn: () => {
      const params: Record<string, unknown> = {};
      if (statusFilter) params.status = statusFilter;
      if (regionFilter) params.region = regionFilter;
      return listClinicalAi(SITES_PATH, params) as Promise<
        FederationSiteListResult & { count: number }
      >;
    },
  });

  const [siteKey, setSiteKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [region, setRegion] = useState("");
  const [contact, setContact] = useState("");
  const [epsilonBudget, setEpsilonBudget] = useState("");
  const [epsilonSpent, setEpsilonSpent] = useState("");
  const [minCohortSize, setMinCohortSize] = useState("");

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["clinical-ai", MODULE_KEY] });
    queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
  };

  const upsert = useMutation({
    mutationFn: (payload: SiteUpsertPayload) =>
      evaluateClinicalAi(SITES_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Federation site saved");
      invalidateAll();
      setDisplayName("");
      setRegion("");
      setContact("");
      setEpsilonBudget("");
      setEpsilonSpent("");
      setMinCohortSize("");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save federation site"),
  });

  const changeStatus = useMutation({
    mutationFn: ({
      siteId,
      payload,
    }: {
      siteId: number;
      payload: SiteStatusChangePayload;
    }) =>
      patchClinicalAi(
        `${SITES_PATH}/${siteId}/status`,
        payload as Record<string, unknown>
      ),
    onSuccess: () => {
      toast.success("Site status updated");
      invalidateAll();
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to change site status"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = siteKey.trim();
    if (!key) {
      toast.error("site_key is required");
      return;
    }
    upsert.mutate({
      site_key: key,
      display_name: displayName.trim() || null,
      region: region.trim() || null,
      contact: contact.trim() || null,
      dp_epsilon_budget: toOptionalNumber(epsilonBudget),
      dp_epsilon_spent: toOptionalNumber(epsilonSpent),
      min_cohort_size: toOptionalNumber(minCohortSize),
    });
  };

  const onStatusChange = (row: FederationSiteRow, nextStatus: SiteStatus) => {
    if (nextStatus === row.status) return;
    const note = window.prompt(`Note for status change to ${nextStatus} (optional)`);
    changeStatus.mutate({
      siteId: row.id,
      payload: { status: nextStatus, approval_note: note ?? null },
    });
  };

  const onApprovalChange = (
    row: FederationSiteRow,
    nextApproval: ApprovalStatus
  ) => {
    if (nextApproval === row.approval_status) return;
    const note = window.prompt(
      `Note for approval change to ${nextApproval} (optional)`
    );
    changeStatus.mutate({
      siteId: row.id,
      payload: {
        status: row.status,
        approval_status: nextApproval,
        approval_note: note ?? null,
      },
    });
  };

  const rows = sites.data?.sites ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">Participating Sites</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {SITE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {readableKey(value)}
              </option>
            ))}
          </select>
          <input
            value={regionFilter}
            onChange={(event) => setRegionFilter(event.target.value)}
            placeholder="region"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
            aria-label="Filter by region"
          />
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-border bg-card p-4"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Site key *</span>
            <input
              value={siteKey}
              onChange={(event) => setSiteKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. site_aiims_delhi"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Region</span>
            <input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. ap-south-1"
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-3">
            <span className="text-muted-foreground">Contact</span>
            <input
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. ops@site.example"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">DP ε budget</span>
            <input
              value={epsilonBudget}
              onChange={(event) => setEpsilonBudget(event.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. 10"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">DP ε spent</span>
            <input
              value={epsilonSpent}
              onChange={(event) => setEpsilonSpent(event.target.value)}
              inputMode="decimal"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. 1.25"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Min cohort size</span>
            <input
              value={minCohortSize}
              onChange={(event) => setMinCohortSize(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              placeholder="e.g. 100"
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
            {upsert.isPending ? "Saving…" : "Save site"}
          </button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Site</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Region</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Approval</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">DP ε spent / budget</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Min cohort</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sites.isLoading ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={7}
                >
                  Loading…
                </td>
              </tr>
            ) : sites.isError ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-red-600"
                  colSpan={7}
                >
                  {(sites.error as Error)?.message || "Failed to load sites"}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-8 text-center text-sm text-slate-500"
                  colSpan={7}
                >
                  No federation sites recorded
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.display_name ?? row.site_key}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {row.site_key}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">{row.region ?? "-"}</td>
                  <td className="px-4 py-3">
                    <select
                      value={row.status}
                      onChange={(event) =>
                        onStatusChange(row, event.target.value as SiteStatus)
                      }
                      disabled={changeStatus.isPending}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      aria-label={`Change status for ${row.site_key}`}
                    >
                      {SITE_STATUSES.map((value) => (
                        <option key={value} value={value}>
                          {readableKey(value)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={row.approval_status}
                      onChange={(event) =>
                        onApprovalChange(
                          row,
                          event.target.value as ApprovalStatus
                        )
                      }
                      disabled={changeStatus.isPending}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      aria-label={`Change approval for ${row.site_key}`}
                    >
                      {APPROVAL_STATES.map((value) => (
                        <option key={value} value={value}>
                          {readableKey(value)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {row.dp_epsilon_spent ?? "-"} / {row.dp_epsilon_budget ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-xs">{row.min_cohort_size ?? "-"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmt(row.last_seen_at)}
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
// Bottom-tier: round record form (slot) + decide queue.
// ---------------------------------------------------------------------------
function FederationRoundEvaluateForm() {
  const queryClient = useQueryClient();
  const [roundKey, setRoundKey] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [aggregationMethod, setAggregationMethod] =
    useState<(typeof AGGREGATION_METHODS)[number]>("fed_avg");
  const [participantSiteCount, setParticipantSiteCount] = useState("");
  const [minParticipants, setMinParticipants] = useState("3");
  const [totalDpEpsilonSpent, setTotalDpEpsilonSpent] = useState("");
  const [totalDpEpsilonBudget, setTotalDpEpsilonBudget] = useState("10");
  const [cohortTotalSize, setCohortTotalSize] = useState("");
  const [cohortMinSiteSize, setCohortMinSiteSize] = useState("");
  const [dataDriftScore, setDataDriftScore] = useState("");

  const record = useMutation({
    mutationFn: (payload: RoundRecordPayload) =>
      evaluateClinicalAi(ROUNDS_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Federation round recorded");
      setRoundKey("");
      setModelKey("");
      setParticipantSiteCount("");
      setTotalDpEpsilonSpent("");
      setCohortTotalSize("");
      setCohortMinSiteSize("");
      setDataDriftScore("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", MODULE_KEY] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to record federation round"),
  });

  const canSubmit =
    roundKey.trim().length > 0 && modelKey.trim().length > 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    record.mutate({
      round_key: roundKey.trim(),
      model_key: modelKey.trim(),
      aggregation_method: aggregationMethod,
      participant_site_count: Number(participantSiteCount) || 0,
      min_participants: Number(minParticipants) || 0,
      total_dp_epsilon_spent: Number(totalDpEpsilonSpent) || 0,
      total_dp_epsilon_budget: Number(totalDpEpsilonBudget) || 0,
      cohort_total_size: Number(cohortTotalSize) || 0,
      cohort_min_site_size: toOptionalNumber(cohortMinSiteSize),
      data_drift_score: toOptionalNumber(dataDriftScore),
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Round key *</span>
          <input
            value={roundKey}
            onChange={(event) => setRoundKey(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="e.g. round_2026_04_22"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Model key *</span>
          <input
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="e.g. readmit_risk_v3"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Aggregation method</span>
          <select
            value={aggregationMethod}
            onChange={(event) =>
              setAggregationMethod(
                event.target.value as (typeof AGGREGATION_METHODS)[number]
              )
            }
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            {AGGREGATION_METHODS.map((value) => (
              <option key={value} value={value}>
                {readableKey(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Participant sites</span>
          <input
            value={participantSiteCount}
            onChange={(event) => setParticipantSiteCount(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Min participants</span>
          <input
            value={minParticipants}
            onChange={(event) => setMinParticipants(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">DP ε spent (total)</span>
          <input
            value={totalDpEpsilonSpent}
            onChange={(event) => setTotalDpEpsilonSpent(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">DP ε budget (total)</span>
          <input
            value={totalDpEpsilonBudget}
            onChange={(event) => setTotalDpEpsilonBudget(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Cohort total size</span>
          <input
            value={cohortTotalSize}
            onChange={(event) => setCohortTotalSize(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Cohort min site size</span>
          <input
            value={cohortMinSiteSize}
            onChange={(event) => setCohortMinSiteSize(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Data drift score</span>
          <input
            value={dataDriftScore}
            onChange={(event) => setDataDriftScore(event.target.value)}
            inputMode="decimal"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="0.0 – 1.0"
          />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={record.isPending || !canSubmit}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {record.isPending ? "Recording…" : "Record round"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function FederatedLearningCoordinatorPanel() {
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Federated Learning Coordinator</h2>
      </div>

      <FederationSitesSection />

      <ClinicalAIReviewQueue<FederationRoundRow, FederationRoundDecision>
        title="Federation Rounds"
        moduleKey={MODULE_KEY}
        icon={<Network className="h-4 w-4" />}
        description="Record a federation round to draft a readiness recommendation, then review and decide."
        listFn={(params) => listClinicalAi(ROUNDS_PATH, params)}
        rowsKey="rounds"
        decideFn={(id, decision, note) =>
          decideClinicalAi(ROUNDS_PATH, id, decision, note)
        }
        filters={ROUND_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={ROUND_COLUMNS}
        decideActions={ROUND_DECIDE_ACTIONS}
        evaluateForm={<FederationRoundEvaluateForm />}
        emptyState="No federation rounds pending review"
      />
    </section>
  );
}
