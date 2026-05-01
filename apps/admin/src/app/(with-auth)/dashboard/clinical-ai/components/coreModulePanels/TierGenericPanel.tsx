"use client";

/**
 * Shared admin panel for Tier A-remainder / C / D / E / F / G / H AI modules.
 *
 * Each tier has 5-16 generators that all return the same `PatientExplainerResult`
 * shape (draft + safety_flags + review_status + provider). Rather than
 * hand-build 60+ bespoke forms, this panel takes a list of `TierModule` configs:
 *
 *   { key, label, endpoint, description, body }
 *
 * and renders:
 *   - a tab strip (one tab per module),
 *   - a JSON-textarea pre-filled with the body template (with example values
 *     so an admin sees the input shape immediately),
 *   - a Generate button that POSTs to `endpoint` with the parsed body,
 *   - a result card matching the layout used by `PatientExplainersPanel` and
 *     `SurgicalAiPanel` (safety-flag banner + summary + key_points + next_steps
 *     + when_to_seek_help + source_citations + review_status pill).
 *
 * Drafts go to `clinical_ai_reviews` keyed by module_key — they never auto-
 * publish to the patient app or the staff workflow surface.
 */

import { useMemo, useState, type ComponentType } from "react";
import { useMutation } from "@tanstack/react-query";
import { ListChecks, Send } from "lucide-react";
import { toast } from "react-hot-toast";

import { postJSON } from "@/lib/api/core";
import type {
  PatientExplainerResult,
  PatientExplainerSafetyFlag,
} from "@/lib/api/clinicalAiModules";

export interface TierModule {
  /** Stable module key, used as React key + tab id. */
  key: string;
  /** Tab label (short). */
  label: string;
  /** Optional one-line description shown above the JSON input. */
  description?: string;
  /** Admin endpoint, relative to `/api/v1/admin` (e.g. `/clinical-ai/aki-risk-alerts`). */
  endpoint: string;
  /** Default body the textarea is pre-filled with — should be a valid JSON object. */
  body: Record<string, unknown>;
  /** Optional icon override; falls back to ListChecks. */
  icon?: ComponentType<{ className?: string }>;
}

export interface TierGenericPanelProps {
  /** Section heading rendered at the top. */
  title: string;
  /** One-line description shown under the heading. */
  description: string;
  /** Module list (≥1). The first module is selected by default. */
  modules: TierModule[];
}

function severityBadgeClass(severity?: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  if (s === "low") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function reviewStatusClass(status: string) {
  if (status === "failed") return "bg-red-100 text-red-800 border-red-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

function bodyTemplateString(body: Record<string, unknown>): string {
  return JSON.stringify(body, null, 2);
}

export function TierGenericPanel({ title, description, modules }: TierGenericPanelProps) {
  const initialKey = modules[0]?.key ?? "";
  const [activeKey, setActiveKey] = useState(initialKey);

  // Per-tab body state. Initialise lazily from the module's `body` template
  // so each tab keeps its own edits as the admin clicks between tabs.
  const initialBodies = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of modules) out[m.key] = bodyTemplateString(m.body);
    return out;
  }, [modules]);
  const [bodies, setBodies] = useState<Record<string, string>>(initialBodies);

  const [latest, setLatest] = useState<PatientExplainerResult | null>(null);

  const active = modules.find((m) => m.key === activeKey) ?? modules[0];

  const generate = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error("No module selected");
      const raw = bodies[active.key] ?? bodyTemplateString(active.body);
      let parsed: unknown;
      try {
        parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
      } catch (err) {
        throw new Error(`Body is not valid JSON: ${(err as Error).message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Body must be a JSON object (not array / primitive / null)");
      }
      const path = active.endpoint.startsWith("/admin/")
        ? active.endpoint
        : `/admin${active.endpoint.startsWith("/") ? "" : "/"}${active.endpoint}`;
      return postJSON<PatientExplainerResult>(path, parsed as Record<string, unknown>);
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success(`${active?.label ?? "Module"} drafted`);
    },
    onError: (err: Error) => toast.error(err.message || "Generation failed"),
  });

  const resetBody = () => {
    if (!active) return;
    setBodies((prev) => ({ ...prev, [active.key]: bodyTemplateString(active.body) }));
  };

  const isPending = generate.isPending;
  const Icon = active?.icon ?? ListChecks;

  return (
    <section className="space-y-3">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {modules.map((m) => {
          const TabIcon = m.icon ?? ListChecks;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setActiveKey(m.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                activeKey === m.key
                  ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                  : "text-muted-foreground hover:bg-card"
              }`}
              title={m.description}
            >
              <TabIcon className="h-3.5 w-3.5" />
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-mono text-xs text-muted-foreground">
              POST <span className="text-foreground">/api/v1/admin{active?.endpoint}</span>
            </p>
            {active?.description ? (
              <p className="text-xs text-muted-foreground">{active.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={resetBody}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            Reset to template
          </button>
        </div>
        <textarea
          value={bodies[active?.key ?? ""] ?? ""}
          onChange={(e) => {
            const k = active?.key;
            if (!k) return;
            setBodies((prev) => ({ ...prev, [k]: e.target.value }));
          }}
          rows={10}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {isPending ? "Drafting..." : "Generate"}
          </button>
        </div>
      </div>

      {latest ? <TierResult result={latest} /> : null}
    </section>
  );
}

function TierResult({ result }: { result: PatientExplainerResult }) {
  const flags = Array.isArray(result.safety_flags) ? result.safety_flags : [];
  const critical = flags.filter((f) => String(f.severity || "").toLowerCase() === "critical");
  const high = flags.filter((f) => String(f.severity || "").toLowerCase() === "high");
  const draft = result.draft;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{result.module_key}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${reviewStatusClass(result.review_status)}`}>
          review: {result.review_status}
        </span>
        <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
          {result.provider}
        </span>
        {result.requires_signoff ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
            requires sign-off
          </span>
        ) : null}
        {result.generation_id != null ? (
          <span className="text-xs text-muted-foreground">generation #{result.generation_id}</span>
        ) : (
          <span className="text-xs text-muted-foreground">not persisted (schema_unavailable)</span>
        )}
      </div>

      {critical.length || high.length ? (
        <div className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <div className="font-semibold">
            {critical.length} critical · {high.length} high — review required.
          </div>
          <ul className="space-y-1 text-xs">
            {[...critical, ...high].slice(0, 6).map((flag: PatientExplainerSafetyFlag, idx) => (
              <li
                key={`${flag.code || "flag"}-${idx}`}
                className={`rounded border px-2 py-1 ${severityBadgeClass(flag.severity)}`}
              >
                <span className="font-mono uppercase text-[0.65rem] tracking-wide">{flag.severity}</span>{" "}
                <strong>{flag.code || "FLAG"}</strong>
                {flag.message ? <> — {flag.message}</> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.fallback_used ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          The model returned no parseable draft; a fallback shape is shown. Re-run after checking provider availability.
        </div>
      ) : null}

      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Summary</h3>
        <p className="text-sm leading-relaxed">{draft.explanation_summary || "—"}</p>
      </div>

      {draft.key_points?.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Label</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Value</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {draft.key_points.map((point, idx) => (
                <tr key={`${point.label}-${idx}`}>
                  <td className="px-3 py-1.5 font-medium">{point.label}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{point.value ?? "—"}</td>
                  <td className="px-3 py-1.5">{point.what_it_means ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <ListSection title="Next steps" items={draft.next_steps} emptyHint="No follow-up steps drafted." />
        <ListSection title="When to seek help" items={draft.when_to_seek_help} emptyHint="No red-flag list returned." emphasis />
      </div>

      {draft.source_citations?.length ? (
        <div className="rounded-md border border-border p-2">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Source citations</p>
          <ul className="space-y-1 text-xs">
            {draft.source_citations.map((citation, idx) => (
              <li key={`${citation.source_id}-${idx}`} className="font-mono">
                {citation.source_type} · {citation.source_id}
                {citation.label ? <> — {citation.label}</> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ListSection({
  title,
  items,
  emptyHint,
  emphasis,
}: {
  title: string;
  items: string[];
  emptyHint: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${emphasis ? "border-amber-200 bg-amber-50" : "border-border"}`}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {items?.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {items.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      )}
    </div>
  );
}

export default TierGenericPanel;
