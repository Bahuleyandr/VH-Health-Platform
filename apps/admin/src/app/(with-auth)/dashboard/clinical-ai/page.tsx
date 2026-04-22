"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Cpu, Gauge, RefreshCw, ShieldCheck, ToggleLeft, ToggleRight } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  getClinicalAiGenerations,
  getClinicalAiSafetyFlags,
  getClinicalAiStatus,
  updateClinicalAiModule,
  type ClinicalAiGeneration,
  type ClinicalAiModule,
  type ClinicalAiSafetyFlag,
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

function fmtNumber(value?: number | null) {
  return new Intl.NumberFormat("en-IN").format(value ?? 0);
}

function fmtLatency(value?: number | null) {
  return value ? `${fmtNumber(value)} ms` : "-";
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

export default function ClinicalAiGovernancePage() {
  const queryClient = useQueryClient();
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

  const toggleModule = useMutation({
    mutationFn: (module: ClinicalAiModule) =>
      updateClinicalAiModule(module.module_key, { enabled: !module.enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-status"] });
      toast.success("Clinical AI module updated");
    },
    onError: (err: Error) => toast.error(err.message || "Module update failed"),
  });

  const generationRows: ClinicalAiGeneration[] = generations.data?.generations ?? [];
  const flagRows: ClinicalAiSafetyFlag[] = flags.data?.flags ?? [];
  const modules = status.data?.modules ?? [];
  const usage = status.data?.usage;
  const providerHealth = status.data?.providerHealth;

  return (
    <div className="space-y-6">
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
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
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
      </div>

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
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {modules.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                    No modules found
                  </td>
                </tr>
              ) : (
                modules.map((module) => {
                  const row = usage?.by_module.find((item) => item.module_key === module.module_key);
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
