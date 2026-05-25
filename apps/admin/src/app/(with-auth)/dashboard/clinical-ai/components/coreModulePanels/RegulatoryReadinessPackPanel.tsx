"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CloudDownload, ScrollText } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  exportPilotEvidencePack,
  exportReadinessPack,
  type PilotEvidencePack,
  type ReadinessPack,
} from "@/lib/api/clinicalAiAdmin";

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

function downloadJsonPack(pack: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadReadinessPack(pack: ReadinessPack) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJsonPack(pack, `readiness-pack-${pack.module_key}-${timestamp}.json`);
}

function downloadPilotEvidencePack(pack: PilotEvidencePack) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stage = pack.pilot_stage.replace(/[^a-z0-9_-]+/gi, "-");
  downloadJsonPack(pack, `pilot-evidence-pack-${stage}-${timestamp}.json`);
}

function summariseRowCounts(rowCounts: Record<string, number>) {
  const entries = Object.entries(rowCounts).filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) return "no rows";
  return entries.map(([section, count]) => `${section}: ${count}`).join(", ");
}

function summariseBiasSignals(counts: ReadinessPack["summary"]["bias_signal_counts"]) {
  const total = (counts.critical || 0) + (counts.high || 0) + (counts.medium || 0);
  if (total === 0) return "no bias signals";
  return `${total} bias signal${total === 1 ? "" : "s"} (${counts.critical}/${counts.high}/${counts.medium} crit/high/med)`;
}

function parseModuleKeys(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarisePilotBlockers(pack: PilotEvidencePack) {
  const count = pack.summary.blockers.length;
  if (count === 0) return "ready";
  return `${count} blocker${count === 1 ? "" : "s"}`;
}

export function RegulatoryReadinessPackPanel() {
  const [moduleKey, setModuleKey] = useState("");
  const [fromVersion, setFromVersion] = useState("");
  const [toVersion, setToVersion] = useState("");
  const [lastPack, setLastPack] = useState<ReadinessPack | null>(null);
  const [pilotStage, setPilotStage] = useState("stage_1_clinical_review");
  const [pilotModuleKeys, setPilotModuleKeys] = useState(
    "medication_reconciliation, patient_aftercare_instructions"
  );
  const [pilotWindowDays, setPilotWindowDays] = useState(14);
  const [minReviewedPerModule, setMinReviewedPerModule] = useState(1);
  const [lastPilotPack, setLastPilotPack] = useState<PilotEvidencePack | null>(null);

  const exportPack = useMutation({
    mutationFn: () =>
      exportReadinessPack({
        module_key: moduleKey.trim(),
        from_version: fromVersion.trim() || null,
        to_version: toVersion.trim() || null,
      }),
    onSuccess: (pack) => {
      downloadReadinessPack(pack);
      setLastPack(pack);
      const rows = summariseRowCounts(pack.summary.row_counts);
      const bias = summariseBiasSignals(pack.summary.bias_signal_counts);
      toast.success(`Readiness pack ready — ${rows}; ${bias}`);
    },
    onError: (err: Error) => toast.error(err.message || "Readiness pack export failed"),
  });

  const exportPilotPack = useMutation({
    mutationFn: () =>
      exportPilotEvidencePack({
        pilot_stage: pilotStage.trim() || null,
        module_keys: parseModuleKeys(pilotModuleKeys),
        window_days: pilotWindowDays,
        min_reviewed_per_module: minReviewedPerModule,
      }),
    onSuccess: (pack) => {
      downloadPilotEvidencePack(pack);
      setLastPilotPack(pack);
      const status = pack.summary.pilot_ready ? "ready" : summarisePilotBlockers(pack);
      toast[pack.summary.pilot_ready ? "success" : "error"](`Pilot evidence pack ${status}`);
    },
    onError: (err: Error) => toast.error(err.message || "Pilot evidence pack export failed"),
  });

  const canSubmit = moduleKey.trim().length > 0 && !exportPack.isPending;
  const canSubmitPilot = parseModuleKeys(pilotModuleKeys).length > 0 && !exportPilotPack.isPending;
  const skipped = lastPack ? Object.entries(lastPack.summary.skipped_sections) : [];
  const pilotSkipped = lastPilotPack ? Object.entries(lastPilotPack.summary.skipped_sections) : [];

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Regulatory Readiness Pack</h2>
          </div>
          <button
            onClick={() => exportPack.mutate()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <CloudDownload className="h-4 w-4" />
            {exportPack.isPending ? "Assembling..." : "Export JSON"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bundles module config, model registry, eval runs, canary runs, safety reviews, prompts, and
          reviewer decisions for one module into a single audit-logged JSON pack. Decision-support
          only; never auto-published.
        </p>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 lg:grid-cols-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Module key</span>
              <input
                value={moduleKey}
                onChange={(event) => setModuleKey(event.target.value)}
                placeholder="discharge_summary"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">From version (optional)</span>
              <input
                value={fromVersion}
                onChange={(event) => setFromVersion(event.target.value)}
                placeholder="v1"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">To version (optional)</span>
              <input
                value={toVersion}
                onChange={(event) => setToVersion(event.target.value)}
                placeholder="v3"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
          </div>
        </div>

        {lastPack ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="font-semibold">
                Last pack - {lastPack.module_key}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {lastPack.pack_version}
                </span>
              </h3>
              <span className="text-xs text-muted-foreground">
                Generated {fmt(lastPack.generated_at)} - tenant {lastPack.tenant_id}
              </span>
            </div>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-md border border-border bg-muted/40 p-2">
                <div className="font-semibold text-muted-foreground">Row counts</div>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(lastPack.summary.row_counts).map(([section, count]) => (
                    <li key={section} className="flex justify-between font-mono">
                      <span>{section}</span>
                      <span>{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-md border border-border bg-muted/40 p-2">
                <div className="font-semibold text-muted-foreground">Bias signals</div>
                <ul className="mt-1 space-y-0.5 font-mono">
                  <li className="flex justify-between"><span>critical</span><span>{lastPack.summary.bias_signal_counts.critical}</span></li>
                  <li className="flex justify-between"><span>high</span><span>{lastPack.summary.bias_signal_counts.high}</span></li>
                  <li className="flex justify-between"><span>medium</span><span>{lastPack.summary.bias_signal_counts.medium}</span></li>
                </ul>
              </div>
            </div>
            {skipped.length > 0 ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                <div className="font-semibold">Skipped sections</div>
                <ul className="mt-1 space-y-0.5">
                  {skipped.map(([section, reason]) => (
                    <li key={section}>
                      <span className="font-mono">{section}</span> - {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            {lastPilotPack?.summary.pilot_ready ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
            <h2 className="text-lg font-semibold">Pilot Evidence Pack</h2>
          </div>
          <button
            onClick={() => exportPilotPack.mutate()}
            disabled={!canSubmitPilot}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <CloudDownload className="h-4 w-4" />
            {exportPilotPack.isPending ? "Assembling..." : "Export Pilot JSON"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Bundles tenant-scoped workflow evidence for a pilot stage: enabled modules, labelled
          generations, human review notes, safety decisions, eval gates, approvals, and audit trail.
        </p>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 lg:grid-cols-4">
            <label className="space-y-1 text-sm lg:col-span-2">
              <span className="text-muted-foreground">Module keys</span>
              <input
                value={pilotModuleKeys}
                onChange={(event) => setPilotModuleKeys(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Pilot stage</span>
              <input
                value={pilotStage}
                onChange={(event) => setPilotStage(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Window days</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={pilotWindowDays}
                  onChange={(event) => setPilotWindowDays(Number(event.target.value) || 14)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Min reviews</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={minReviewedPerModule}
                  onChange={(event) => setMinReviewedPerModule(Number(event.target.value) || 1)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs"
                />
              </label>
            </div>
          </div>
        </div>

        {lastPilotPack ? (
          <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="font-semibold">
                Last pilot pack - {lastPilotPack.pilot_stage}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {lastPilotPack.pack_version}
                </span>
              </h3>
              <span className="text-xs text-muted-foreground">
                Generated {fmt(lastPilotPack.generated_at)} - tenant {lastPilotPack.tenant_id}
              </span>
            </div>
            <div
              className={`mb-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${
                lastPilotPack.summary.pilot_ready
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {lastPilotPack.summary.pilot_ready ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {lastPilotPack.summary.pilot_ready ? "Pilot ready" : summarisePilotBlockers(lastPilotPack)}
            </div>
            <div className="grid gap-2 text-xs lg:grid-cols-2">
              {lastPilotPack.summary.module_summary.map((module) => (
                <div key={module.module_key} className="rounded-md border border-border bg-muted/40 p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{module.module_key}</span>
                    <span className={module.final_review_requirement_met ? "text-emerald-700" : "text-amber-700"}>
                      {module.final_review_count}/{module.min_reviewed_required} reviews
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                    <span>enabled: {module.effective_enabled ? "yes" : "no"}</span>
                    <span>risky: {module.risky ? "yes" : "no"}</span>
                    <span>generations: {module.generation_count}</span>
                    <span>fallback/blocked: {module.fallback_or_blocked_count}</span>
                    <span>missing notes: {module.final_reviews_missing_note_count}</span>
                    <span>accepted evals: {module.accepted_eval_count}</span>
                  </div>
                </div>
              ))}
            </div>
            {lastPilotPack.summary.blockers.length > 0 ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                <div className="font-semibold">Blockers</div>
                <ul className="mt-1 space-y-0.5">
                  {lastPilotPack.summary.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${blocker.module_key || index}`}>
                      <span className="font-mono">{blocker.code}</span>
                      {blocker.module_key ? ` - ${blocker.module_key}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {pilotSkipped.length > 0 ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                <div className="font-semibold">Skipped sections</div>
                <ul className="mt-1 space-y-0.5">
                  {pilotSkipped.map(([section, reason]) => (
                    <li key={section}>
                      <span className="font-mono">{section}</span> - {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default RegulatoryReadinessPackPanel;
