"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CloudDownload, ScrollText } from "lucide-react";
import { toast } from "react-hot-toast";
import { exportReadinessPack, type ReadinessPack } from "@/lib/api/clinicalAiAdmin";

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

function downloadReadinessPack(pack: ReadinessPack) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `readiness-pack-${pack.module_key}-${timestamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

export function RegulatoryReadinessPackPanel() {
  const [moduleKey, setModuleKey] = useState("");
  const [fromVersion, setFromVersion] = useState("");
  const [toVersion, setToVersion] = useState("");
  const [lastPack, setLastPack] = useState<ReadinessPack | null>(null);

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

  const canSubmit = moduleKey.trim().length > 0 && !exportPack.isPending;
  const skipped = lastPack ? Object.entries(lastPack.summary.skipped_sections) : [];

  return (
    <section className="space-y-3">
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
          {exportPack.isPending ? "Assembling…" : "Export JSON"}
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
              Last pack — {lastPack.module_key}
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {lastPack.pack_version}
              </span>
            </h3>
            <span className="text-xs text-muted-foreground">
              Generated {fmt(lastPack.generated_at)} · tenant {lastPack.tenant_id}
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
                    <span className="font-mono">{section}</span> — {reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default RegulatoryReadinessPackPanel;
