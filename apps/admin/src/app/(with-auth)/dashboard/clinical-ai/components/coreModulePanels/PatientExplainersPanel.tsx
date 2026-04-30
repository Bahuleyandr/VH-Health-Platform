"use client";

/**
 * Tier A patient explainer admin panel.
 *
 * Tabbed picker over the five backend explainer routes (Lab / Radiology /
 * Generic Report / Prescription / Invoice). Each tab has its own input
 * form. Submission renders the draft (summary + key_points table +
 * next_steps + when_to_seek_help) plus a safety-flag banner if any flags
 * fire and a review_status pill.
 *
 * Listing + sign-off live on the existing /reviews surface, so this panel
 * intentionally only handles the generate side. Drafts created here flow
 * straight into the clinical-AI review queue keyed by module_key.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Beaker, FileText, Image as ImageIcon, Pill, Receipt, Send } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
  type PatientExplainerLanguage,
  type PatientExplainerResult,
  type PatientExplainerSafetyFlag,
} from "@/lib/api/clinicalAiAdmin";

type ExplainerKind = "lab" | "radiology" | "report" | "prescription" | "invoice";

const TABS: Array<{ key: ExplainerKind; label: string; icon: typeof Beaker }> = [
  { key: "lab", label: "Lab result", icon: Beaker },
  { key: "radiology", label: "Radiology", icon: ImageIcon },
  { key: "report", label: "Generic report", icon: FileText },
  { key: "prescription", label: "Prescription", icon: Pill },
  { key: "invoice", label: "Invoice", icon: Receipt },
];

const LANGUAGES: PatientExplainerLanguage[] = ["en", "hi", "ta", "te", "ml", "mr", "bn", "kn"];

const REPORT_TYPES = [
  "consultation",
  "discharge",
  "procedure",
  "second_opinion",
  "referral",
  "operative_note",
  "case_summary",
];

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

function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function PatientExplainersPanel() {
  const [tab, setTab] = useState<ExplainerKind>("lab");
  const [language, setLanguage] = useState<PatientExplainerLanguage>("en");

  const [investigationId, setInvestigationId] = useState("");
  const [radiologyOrderId, setRadiologyOrderId] = useState("");
  const [reportType, setReportType] = useState("consultation");
  const [reportText, setReportText] = useState("");
  const [reportPatientUid, setReportPatientUid] = useState("");
  const [prescriptionId, setPrescriptionId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");

  const [latest, setLatest] = useState<PatientExplainerResult | null>(null);

  const lab = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(investigationId);
      if (id == null) throw new Error("investigation_id must be a positive integer");
      return generateLabPatientExplanation({ investigation_id: id, language });
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success("Lab explainer drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Lab explainer failed"),
  });

  const radiology = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(radiologyOrderId);
      if (id == null) throw new Error("radiology_order_id must be a positive integer");
      return generateRadiologyPatientExplanation({ radiology_order_id: id, language });
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success("Radiology explainer drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Radiology explainer failed"),
  });

  const report = useMutation({
    mutationFn: () => {
      const text = reportText.trim();
      if (!reportType.trim()) throw new Error("report_type is required");
      if (text.length < 30) throw new Error("report_text must be at least 30 characters");
      const trimmedUid = reportPatientUid.trim();
      return generatePatientReportExplanation({
        report_type: reportType.trim(),
        report_text: text,
        patient_uid: trimmedUid || null,
        language,
      });
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success("Report explainer drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Report explainer failed"),
  });

  const prescription = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(prescriptionId);
      if (id == null) throw new Error("prescription_id must be a positive integer");
      return generatePrescriptionPatientExplanation({ prescription_id: id, language });
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success("Prescription explainer drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Prescription explainer failed"),
  });

  const invoice = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(invoiceId);
      if (id == null) throw new Error("invoice_id must be a positive integer");
      return generateInvoicePatientExplanation({ invoice_id: id, language });
    },
    onSuccess: (result) => {
      setLatest(result);
      toast.success("Invoice explainer drafted");
    },
    onError: (err: Error) => toast.error(err.message || "Invoice explainer failed"),
  });

  const isPending =
    lab.isPending || radiology.isPending || report.isPending || prescription.isPending || invoice.isPending;

  const submit = () => {
    if (tab === "lab") lab.mutate();
    else if (tab === "radiology") radiology.mutate();
    else if (tab === "report") report.mutate();
    else if (tab === "prescription") prescription.mutate();
    else invoice.mutate();
  };

  const canSubmit = (() => {
    if (isPending) return false;
    if (tab === "lab") return parsePositiveInt(investigationId) != null;
    if (tab === "radiology") return parsePositiveInt(radiologyOrderId) != null;
    if (tab === "report") return reportType.trim().length > 0 && reportText.trim().length >= 30;
    if (tab === "prescription") return parsePositiveInt(prescriptionId) != null;
    return parsePositiveInt(invoiceId) != null;
  })();

  return (
    <section className="space-y-3">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Patient Explainers</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Drafts go to the clinical-AI review queue keyed by module_key — they never auto-publish to the patient app.
        </p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === key
                ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                : "text-muted-foreground hover:bg-card"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-card p-3">
        <div className="grid gap-2 lg:grid-cols-12">
          {tab === "lab" ? (
            <label className="space-y-1 text-sm lg:col-span-6">
              <span className="text-muted-foreground">Investigation ID</span>
              <input
                value={investigationId}
                onChange={(e) => setInvestigationId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 42"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
          ) : null}
          {tab === "radiology" ? (
            <label className="space-y-1 text-sm lg:col-span-6">
              <span className="text-muted-foreground">Radiology Order ID</span>
              <input
                value={radiologyOrderId}
                onChange={(e) => setRadiologyOrderId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 18"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
          ) : null}
          {tab === "report" ? (
            <>
              <label className="space-y-1 text-sm lg:col-span-3">
                <span className="text-muted-foreground">Report type</span>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                >
                  {REPORT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm lg:col-span-3">
                <span className="text-muted-foreground">Patient UID (optional)</span>
                <input
                  value={reportPatientUid}
                  onChange={(e) => setReportPatientUid(e.target.value)}
                  placeholder="00000000-0000-4000-8000-…"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="space-y-1 text-sm lg:col-span-12">
                <span className="text-muted-foreground">Report text (≥ 30 chars)</span>
                <textarea
                  value={reportText}
                  onChange={(e) => setReportText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                  placeholder="Paste the consultation / procedure / discharge note text here."
                />
              </label>
            </>
          ) : null}
          {tab === "prescription" ? (
            <label className="space-y-1 text-sm lg:col-span-6">
              <span className="text-muted-foreground">Prescription ID</span>
              <input
                value={prescriptionId}
                onChange={(e) => setPrescriptionId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 9"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
          ) : null}
          {tab === "invoice" ? (
            <label className="space-y-1 text-sm lg:col-span-6">
              <span className="text-muted-foreground">Invoice ID</span>
              <input
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 11"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
          ) : null}

          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as PatientExplainerLanguage)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono"
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <div className="lg:col-span-3 flex items-end">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {isPending ? "Drafting..." : "Generate"}
            </button>
          </div>
        </div>
      </div>

      {latest ? <ExplainerResult result={latest} /> : null}
    </section>
  );
}

function ExplainerResult({ result }: { result: PatientExplainerResult }) {
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
        <h3 className="text-sm font-semibold">Patient summary</h3>
        <p className="text-sm leading-relaxed">{draft.explanation_summary || "—"}</p>
      </div>

      {draft.key_points?.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Label</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Value</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">What it means</th>
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

export default PatientExplainersPanel;
