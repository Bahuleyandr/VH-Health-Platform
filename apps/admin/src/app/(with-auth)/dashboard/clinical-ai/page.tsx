"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getClinicalAiConfig,
  getClinicalAiGenerations,
  getClinicalAiSafetyFlags,
  type ClinicalAiGeneration,
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

function severityClass(severity?: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

export default function ClinicalAiGovernancePage() {
  const config = useQuery({
    queryKey: ["clinical-ai-config"],
    queryFn: getClinicalAiConfig,
  });
  const generations = useQuery({
    queryKey: ["clinical-ai-generations"],
    queryFn: getClinicalAiGenerations,
  });
  const flags = useQuery({
    queryKey: ["clinical-ai-safety-flags"],
    queryFn: getClinicalAiSafetyFlags,
  });

  const generationRows: ClinicalAiGeneration[] = generations.data?.generations ?? [];
  const flagRows: ClinicalAiSafetyFlag[] = flags.data?.flags ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Clinical AI</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Local model status, draft generations, and safety review flags
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Provider</div>
          <div className="mt-1 text-xl font-semibold">
            {config.data?.provider ?? "template"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Model</div>
          <div className="mt-1 text-xl font-semibold">
            {config.data?.model ?? "-"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Local AI</div>
          <div className="mt-1 text-xl font-semibold">
            {config.data?.enabled ? "Enabled" : "Fallback"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Open Flags</div>
          <div className="mt-1 text-xl font-semibold">{flagRows.length}</div>
        </div>
      </div>

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
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Flags</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {generationRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                    No clinical AI drafts found
                  </td>
                </tr>
              ) : (
                generationRows.map((generation) => (
                  <tr key={generation.id}>
                    <td className="px-4 py-3">{generation.task_type}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{generation.patient_name ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{generation.patient_uid ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">
                      {generation.provider}
                      {generation.used_ai ? "" : " fallback"}
                    </td>
                    <td className="px-4 py-3">{generation.status}</td>
                    <td className="px-4 py-3">{generation.safety_flags?.length ?? 0}</td>
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
