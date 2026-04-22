"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Cpu, Gauge, History, RefreshCw, ShieldCheck, ToggleLeft, ToggleRight } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  getClinicalAiAuditLogs,
  getClinicalAiGenerations,
  getClinicalAiSafetyFlags,
  getClinicalAiStatus,
  updateClinicalAiGuardrails,
  updateClinicalAiModule,
  type ClinicalAiBudgetStatus,
  type ClinicalAiAuditLog,
  type ClinicalAiGeneration,
  type ClinicalAiGuardrails,
  type ClinicalAiModule,
  type ClinicalAiSafetyFlag,
} from "@/lib/api/emr";
import { useAuth } from "@/contexts/AuthContext";
import {
  ApprovalsPanel,
  BreakGlassBanner,
  BreakGlassControls,
  CorpusHealthPanel,
  DeadLetterPanel,
  LongitudinalRiskPanel,
  PromptRegistryPanel,
  ReviewQueuePanel,
  SelfHealingPanel,
  TranslationsPanel,
} from "./components/GovernancePanels";
import {
  AIExpansionHeader,
  AmbientDocumentationPanel,
  ChartCompletionPanel,
  ChargeCapturePanel,
  DeteriorationPanel,
  DocumentIntelligencePanel,
  DriftCanaryPanel,
  ImagingAIPanel,
  PolypharmacyPanel,
  PriorAuthorizationPanel,
  PromptExperimentsPanel,
  RcaDraftsPanel,
  RosterOptimizerPanel,
  TrialCatalogSyncPanel,
  TrialMatchesPanel,
  VirtualWardPanel,
} from "./components/AIExpansionPanels";

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

function fmtNumber(value?: number | null) {
  return new Intl.NumberFormat("en-IN").format(value ?? 0);
}

function fmtLatency(value?: number | null) {
  return value ? `${fmtNumber(value)} ms` : "-";
}

function fmtCostMinor(value?: number | null) {
  return value === null || value === undefined ? "-" : `${fmtNumber(value)} minor`;
}

function capPercent(value?: number | null) {
  return Math.min(Math.max(value ?? 0, 0), 100);
}

function toOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function severityClass(severity?: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function statusClass(status?: string) {
  const s = (status || "").toLowerCase();
  if (s === "reachable" || s === "configured") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (s === "blocked") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-red-100 text-red-800 border-red-200";
}

function boundaryLabel(module: ClinicalAiModule) {
  return module.external_allowed ? "External allowed" : "Local only";
}

function auditActionLabel(action: string) {
  return action
    .replace(/^CLINICAL_AI_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function auditActor(log: ClinicalAiAuditLog) {
  const role = log.metadata?.actor?.role || log.role || "-";
  const uid = log.metadata?.actor?.uid || log.uid;
  return uid ? `${role} / ${uid.slice(0, 8)}` : role;
}

function auditChangedFields(log: ClinicalAiAuditLog) {
  const fields = log.metadata?.changed_fields ?? [];
  return fields.length ? fields.join(", ") : "-";
}

function ModuleToggle({
  module,
  disabled,
  onToggle,
}: {
  module: ClinicalAiModule;
  disabled: boolean;
  onToggle: (module: ClinicalAiModule) => void;
}) {
  return (
    <button
      onClick={() => onToggle(module)}
      disabled={disabled}
      className="inline-flex min-w-24 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
      title={module.enabled ? "Disable" : "Enable"}
    >
      {module.enabled ? (
        <ToggleRight className="h-4 w-4 text-emerald-600" />
      ) : (
        <ToggleLeft className="h-4 w-4 text-muted-foreground" />
      )}
      {module.enabled ? "Enabled" : "Disabled"}
    </button>
  );
}

type GuardrailDraft = {
  daily_token_limit: string;
  daily_cost_limit_minor: string;
  request_token_limit: string;
  fallback_rate_alert_pct: string;
  max_fallbacks_per_day: string;
  latency_alert_ms: string;
};

function guardrailDraftFrom(guardrails?: ClinicalAiGuardrails): GuardrailDraft {
  return {
    daily_token_limit: guardrails?.daily_token_limit?.toString() ?? "",
    daily_cost_limit_minor: guardrails?.daily_cost_limit_minor?.toString() ?? "",
    request_token_limit: guardrails?.request_token_limit?.toString() ?? "",
    fallback_rate_alert_pct: guardrails?.fallback_rate_alert_pct?.toString() ?? "50",
    max_fallbacks_per_day: guardrails?.max_fallbacks_per_day?.toString() ?? "",
    latency_alert_ms: guardrails?.latency_alert_ms?.toString() ?? "15000",
  };
}

function GuardrailEditor({
  guardrails,
  budget,
  disabled,
  onSave,
  onToggleEnabled,
  onToggleExternal,
}: {
  guardrails?: ClinicalAiGuardrails;
  budget?: ClinicalAiBudgetStatus;
  disabled: boolean;
  onSave: (payload: Partial<ClinicalAiGuardrails>) => void;
  onToggleEnabled: () => void;
  onToggleExternal: () => void;
}) {
  const [draft, setDraft] = useState<GuardrailDraft>(() => guardrailDraftFrom(guardrails));

  useEffect(() => {
    setDraft(guardrailDraftFrom(guardrails));
  }, [guardrails]);

  const setField = (field: keyof GuardrailDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const save = () => {
    onSave({
      daily_token_limit: toOptionalNumber(draft.daily_token_limit),
      daily_cost_limit_minor: toOptionalNumber(draft.daily_cost_limit_minor),
      request_token_limit: toOptionalNumber(draft.request_token_limit),
      fallback_rate_alert_pct: toOptionalNumber(draft.fallback_rate_alert_pct) ?? 50,
      max_fallbacks_per_day: toOptionalNumber(draft.max_fallbacks_per_day),
      latency_alert_ms: toOptionalNumber(draft.latency_alert_ms) ?? 15000,
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Budget Guardrails</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onToggleEnabled}
            disabled={!guardrails || disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {guardrails?.enabled ? (
              <ToggleRight className="h-4 w-4 text-emerald-600" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
            )}
            Guardrails
          </button>
          <button
            onClick={onToggleExternal}
            disabled={!guardrails || disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {guardrails?.external_ai_enabled ? (
              <ToggleRight className="h-4 w-4 text-emerald-600" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
            )}
            External AI
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Daily Tokens</div>
          <div className="mt-1 text-xl font-semibold">
            {fmtNumber(budget?.token_budget.used)} / {budget?.token_budget.limit ? fmtNumber(budget.token_budget.limit) : "-"}
          </div>
          <div className="mt-3 h-2 rounded-full bg-muted">
            <div
              className={`h-2 rounded-full ${budget?.token_budget.tripped ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ width: `${capPercent(budget?.token_budget.percent_used)}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Daily Cost</div>
          <div className="mt-1 text-xl font-semibold">
            {fmtCostMinor(budget?.cost_budget.used)} / {fmtCostMinor(budget?.cost_budget.limit)}
          </div>
          <div className="mt-3 h-2 rounded-full bg-muted">
            <div
              className={`h-2 rounded-full ${budget?.cost_budget.tripped ? "bg-red-500" : "bg-cyan-500"}`}
              style={{ width: `${capPercent(budget?.cost_budget.percent_used)}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Fallback Rate</div>
          <div className="mt-1 text-xl font-semibold">{fmtNumber(budget?.fallback_rate_pct)}%</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Alert at {fmtNumber(guardrails?.fallback_rate_alert_pct)}%
          </div>
        </div>
      </div>

      {(budget?.alerts ?? []).length > 0 ? (
        <div className="space-y-2">
          {(budget?.alerts ?? []).map((alert) => (
            <div
              key={alert.code}
              className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                alert.severity === "block"
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div>
                <div className="font-medium">{alert.code}</div>
                <div>{alert.message}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Daily token cap</span>
            <input
              type="number"
              min={0}
              value={draft.daily_token_limit}
              onChange={(event) => setField("daily_token_limit", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Daily cost cap</span>
            <input
              type="number"
              min={0}
              value={draft.daily_cost_limit_minor}
              onChange={(event) => setField("daily_cost_limit_minor", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Output token cap</span>
            <input
              type="number"
              min={256}
              value={draft.request_token_limit}
              onChange={(event) => setField("request_token_limit", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Fallback alert %</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.fallback_rate_alert_pct}
              onChange={(event) => setField("fallback_rate_alert_pct", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Fallback count alert</span>
            <input
              type="number"
              min={0}
              value={draft.max_fallbacks_per_day}
              onChange={(event) => setField("max_fallbacks_per_day", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Latency alert ms</span>
            <input
              type="number"
              min={1000}
              value={draft.latency_alert_ms}
              onChange={(event) => setField("latency_alert_ms", event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={!guardrails || disabled}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            Save Guardrails
          </button>
        </div>
      </div>
    </section>
  );
}

export default function ClinicalAiGovernancePage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const status = useQuery({
    queryKey: ["clinical-ai-status"],
    queryFn: () => getClinicalAiStatus(7),
    refetchInterval: 30000,
  });
  const generations = useQuery({
    queryKey: ["clinical-ai-generations"],
    queryFn: getClinicalAiGenerations,
  });
  const flags = useQuery({
    queryKey: ["clinical-ai-safety-flags"],
    queryFn: getClinicalAiSafetyFlags,
  });
  const auditLogs = useQuery({
    queryKey: ["clinical-ai-audit"],
    queryFn: () => getClinicalAiAuditLogs(50),
  });

  const toggleModule = useMutation({
    mutationFn: (module: ClinicalAiModule) =>
      updateClinicalAiModule(module.module_key, { enabled: !module.enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-status"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
      toast.success("Clinical AI module updated");
    },
    onError: (err: Error) => toast.error(err.message || "Module update failed"),
  });

  const saveGuardrails = useMutation({
    mutationFn: (payload: Partial<ClinicalAiGuardrails>) => updateClinicalAiGuardrails(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-status"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
      toast.success("Clinical AI guardrails updated");
    },
    onError: (err: Error) => toast.error(err.message || "Guardrail update failed"),
  });

  const generationRows: ClinicalAiGeneration[] = generations.data?.generations ?? [];
  const flagRows: ClinicalAiSafetyFlag[] = flags.data?.flags ?? [];
  const auditRows: ClinicalAiAuditLog[] = auditLogs.data?.logs ?? [];
  const modules = status.data?.modules ?? [];
  const usage = status.data?.usage;
  const providerHealth = status.data?.providerHealth;
  const guardrails = status.data?.guardrails;
  const budget = status.data?.budget;

  return (
    <div className="space-y-6">
      <BreakGlassBanner />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Clinical AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Provider status, usage, modules, and safety flags
          </p>
        </div>
        <button
          onClick={() => {
            status.refetch();
            generations.refetch();
            flags.refetch();
            auditLogs.refetch();
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Cpu className="h-4 w-4" />
            Provider
          </div>
          <div className="mt-1 text-xl font-semibold">{status.data?.config.provider ?? "template"}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{status.data?.config.model ?? "-"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            Status
          </div>
          <div className="mt-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(providerHealth?.status)}`}>
              {providerHealth?.status ?? "loading"}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground" title={providerHealth?.reason ?? undefined}>
            {providerHealth?.reason ?? fmtLatency(providerHealth?.latencyMs)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Gauge className="h-4 w-4" />
            Tokens
          </div>
          <div className="mt-1 text-xl font-semibold">{fmtNumber(usage?.overall.total_tokens)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {fmtNumber(usage?.overall.prompt_tokens)} in / {fmtNumber(usage?.overall.completion_tokens)} out
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Avg Latency</div>
          <div className="mt-1 text-xl font-semibold">{fmtLatency(usage?.overall.avg_latency_ms)}</div>
          <div className="mt-1 text-xs text-muted-foreground">{fmtNumber(usage?.overall.generation_count)} drafts</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Safety Flags
          </div>
          <div className="mt-1 text-xl font-semibold">{flagRows.length}</div>
          <div className="mt-1 text-xs text-muted-foreground">{fmt(usage?.overall.last_generation_at)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Budget
          </div>
          <div className="mt-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${budget?.tripped ? "border-red-200 bg-red-100 text-red-800" : "border-emerald-200 bg-emerald-100 text-emerald-800"}`}>
              {budget?.tripped ? "Blocked" : "Clear"}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {budget?.alerts.length ? `${budget.alerts.length} alerts` : "No alerts"}
          </div>
        </div>
      </div>

      <GuardrailEditor
        guardrails={guardrails}
        budget={budget}
        disabled={saveGuardrails.isPending}
        onSave={(payload) => saveGuardrails.mutate(payload)}
        onToggleEnabled={() => {
          if (!guardrails) return;
          saveGuardrails.mutate({ enabled: !guardrails.enabled });
        }}
        onToggleExternal={() => {
          if (!guardrails) return;
          saveGuardrails.mutate({ external_ai_enabled: !guardrails.external_ai_enabled });
        }}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Modules</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Boundary</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Usage</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Acceptance</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {modules.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                    No modules found
                  </td>
                </tr>
              ) : (
                modules.map((module) => {
                  const row = usage?.by_module.find((item) => item.module_key === module.module_key);
                  const acceptanceRate = row?.acceptance_rate_pct;
                  const reviewCount = row?.review_count ?? 0;
                  return (
                    <tr key={module.module_key}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{module.display_name}</div>
                        <div className="text-xs text-muted-foreground">{module.module_key}</div>
                      </td>
                      <td className="px-4 py-3">{boundaryLabel(module)}</td>
                      <td className="px-4 py-3">
                        {module.provider_override || status.data?.config.provider || "template"}
                        {module.model_override ? (
                          <div className="text-xs text-muted-foreground">{module.model_override}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div>{fmtNumber(row?.total_tokens)} tokens</div>
                        <div className="text-xs text-muted-foreground">{fmtLatency(row?.avg_latency_ms)}</div>
                      </td>
                      <td className="px-4 py-3">
                        {acceptanceRate === null || acceptanceRate === undefined ? (
                          <span className="text-xs text-muted-foreground">No reviews</span>
                        ) : (
                          <div>
                            <div className="font-medium">{acceptanceRate}%</div>
                            <div className="text-xs text-muted-foreground">
                              {row?.accepted_count ?? 0} / {reviewCount} accepted
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ModuleToggle
                          module={module}
                          disabled={toggleModule.isPending}
                          onToggle={(target) => toggleModule.mutate(target)}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ReviewQueuePanel />

      <PromptRegistryPanel
        modules={modules.map((module) => ({
          module_key: module.module_key,
          display_name: module.display_name,
        }))}
      />

      <ApprovalsPanel currentAdminUid={user?.uid ?? null} />

      <BreakGlassControls />

      <CorpusHealthPanel />

      <LongitudinalRiskPanel />

      <TranslationsPanel />

      <DeadLetterPanel />

      <SelfHealingPanel />

      <AIExpansionHeader />

      <PromptExperimentsPanel />

      <DriftCanaryPanel />

      <DeteriorationPanel />

      <ImagingAIPanel />

      <VirtualWardPanel />

      <DocumentIntelligencePanel />

      <ChartCompletionPanel />

      <AmbientDocumentationPanel />

      <RosterOptimizerPanel />

      <PolypharmacyPanel />

      <TrialCatalogSyncPanel />

      <TrialMatchesPanel />

      <RcaDraftsPanel />

      <ChargeCapturePanel />

      <PriorAuthorizationPanel />

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Audit Trail</h2>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Action</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Actor</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Target</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Changed</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {auditRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                    No Clinical AI audit entries found
                  </td>
                </tr>
              ) : (
                auditRows.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-3">{auditActionLabel(log.action)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{auditActor(log)}</td>
                    <td className="px-4 py-3">{log.resource_id ?? log.resource ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{auditChangedFields(log)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(log.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Provider Usage</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Drafts</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tokens</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(usage?.by_provider ?? []).length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={4}>
                      No provider usage found
                    </td>
                  </tr>
                ) : (
                  usage?.by_provider.map((provider) => (
                    <tr key={provider.provider}>
                      <td className="px-4 py-3">{provider.provider}</td>
                      <td className="px-4 py-3">{fmtNumber(provider.generation_count)}</td>
                      <td className="px-4 py-3">{fmtNumber(provider.total_tokens)}</td>
                      <td className="px-4 py-3">{fmtLatency(provider.avg_latency_ms)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent Fallbacks</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(usage?.recent_failures ?? []).length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={3}>
                      No fallbacks found
                    </td>
                  </tr>
                ) : (
                  usage?.recent_failures.map((failure) => (
                    <tr key={failure.id}>
                      <td className="px-4 py-3">{failure.module_key || failure.task_type}</td>
                      <td className="px-4 py-3">{failure.provider}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(failure.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Safety Flags</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Code</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Message</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {flagRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                    No safety flags found
                  </td>
                </tr>
              ) : (
                flagRows.map((flag) => (
                  <tr key={`${flag.generation_id}-${flag.code}-${flag.created_at}`}>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityClass(flag.severity)}`}>
                        {flag.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{flag.patient_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{flag.patient_uid ?? ""}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{flag.code}</td>
                    <td className="px-4 py-3">{flag.message}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(flag.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent Drafts</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Task</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tokens</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Latency</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {generationRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                    No clinical AI drafts found
                  </td>
                </tr>
              ) : (
                generationRows.map((generation) => (
                  <tr key={generation.id}>
                    <td className="px-4 py-3">
                      <div>{generation.module_key || generation.task_type}</div>
                      <div className="text-xs text-muted-foreground">{generation.safety_flags?.length ?? 0} flags</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{generation.patient_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{generation.patient_uid ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">
                      {generation.provider}
                      {generation.used_ai ? "" : " fallback"}
                    </td>
                    <td className="px-4 py-3">{fmtNumber(generation.total_tokens)}</td>
                    <td className="px-4 py-3">{fmtLatency(generation.latency_ms)}</td>
                    <td className="px-4 py-3">{generation.status}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(generation.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
