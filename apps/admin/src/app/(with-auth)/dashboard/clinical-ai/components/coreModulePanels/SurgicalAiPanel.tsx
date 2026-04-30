"use client";

/**
 * Tier B PR2 — surgical / OR AI module admin panel.
 *
 * Tabbed picker over the eight surgical AI generators. Each tab takes an
 * ot_schedule_id (and optional tab-specific knobs) and renders the draft +
 * safety flags + review_status pill. Drafts flow into the existing
 * /reviews surface keyed by module_key.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Box,
  ClipboardCheck,
  FileSignature,
  Send,
  Shield,
  Stethoscope,
  Syringe,
  TrendingUp,
} from "lucide-react";
import { toast } from "react-hot-toast";

import {
  detectPostOpComplications,
  draftOperativeNote,
  draftPostOpInstructions,
  draftSurgicalConsent,
  reviewPreopChecklist,
  runAnesthesiaPrecheck,
  summarizeSurgicalRisk,
  trackImplantsAndConsumables,
  type PatientExplainerLanguage,
  type PatientExplainerSafetyFlag,
  type SurgicalAiResult,
} from "@/lib/api/clinicalAiAdmin";

type SurgicalKind =
  | "preop"
  | "consent"
  | "ot_note"
  | "postop_inst"
  | "risk"
  | "anaesthesia"
  | "implants"
  | "complications";

const TABS: Array<{ key: SurgicalKind; label: string; icon: typeof ClipboardCheck }> = [
  { key: "preop", label: "Pre-op review", icon: ClipboardCheck },
  { key: "consent", label: "Consent draft", icon: FileSignature },
  { key: "ot_note", label: "OT note", icon: Stethoscope },
  { key: "postop_inst", label: "Post-op instructions", icon: Syringe },
  { key: "risk", label: "Risk summary", icon: Shield },
  { key: "anaesthesia", label: "Anaesthesia precheck", icon: Stethoscope },
  { key: "implants", label: "Implant tracking", icon: Box },
  { key: "complications", label: "Complication alert", icon: AlertTriangle },
];

const LANGUAGES: PatientExplainerLanguage[] = ["en", "hi", "ta", "te", "ml", "mr", "bn", "kn"];

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

export function SurgicalAiPanel() {
  const [tab, setTab] = useState<SurgicalKind>("preop");
  const [scheduleId, setScheduleId] = useState("");
  const [language, setLanguage] = useState<PatientExplainerLanguage>("en");
  const [comorbiditiesText, setComorbiditiesText] = useState("");
  const [surgeonNotes, setSurgeonNotes] = useState("");
  const [latest, setLatest] = useState<SurgicalAiResult | null>(null);

  function commonOnSuccess(label: string) {
    return (result: SurgicalAiResult) => {
      setLatest(result);
      toast.success(`${label} drafted`);
    };
  }
  function commonOnError(label: string) {
    return (err: Error) => toast.error(err.message || `${label} failed`);
  }

  const preop = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return reviewPreopChecklist({ ot_schedule_id: id });
    },
    onSuccess: commonOnSuccess("Pre-op review"),
    onError: commonOnError("Pre-op review"),
  });

  const consent = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      const comorbidities = comorbiditiesText.trim()
        ? comorbiditiesText.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      return draftSurgicalConsent({
        ot_schedule_id: id,
        language,
        patient_comorbidities: comorbidities,
      });
    },
    onSuccess: commonOnSuccess("Consent"),
    onError: commonOnError("Consent"),
  });

  const otNote = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return draftOperativeNote({
        ot_schedule_id: id,
        surgeon_notes: surgeonNotes.trim() || null,
      });
    },
    onSuccess: commonOnSuccess("OT note"),
    onError: commonOnError("OT note"),
  });

  const postOpInst = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return draftPostOpInstructions({ ot_schedule_id: id, language });
    },
    onSuccess: commonOnSuccess("Post-op instructions"),
    onError: commonOnError("Post-op instructions"),
  });

  const risk = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return summarizeSurgicalRisk({ ot_schedule_id: id });
    },
    onSuccess: commonOnSuccess("Risk summary"),
    onError: commonOnError("Risk summary"),
  });

  const anaesthesia = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return runAnesthesiaPrecheck({ ot_schedule_id: id });
    },
    onSuccess: commonOnSuccess("Anaesthesia precheck"),
    onError: commonOnError("Anaesthesia precheck"),
  });

  const implants = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return trackImplantsAndConsumables({ ot_schedule_id: id });
    },
    onSuccess: commonOnSuccess("Implant reconciliation"),
    onError: commonOnError("Implant reconciliation"),
  });

  const complications = useMutation({
    mutationFn: () => {
      const id = parsePositiveInt(scheduleId);
      if (id == null) throw new Error("ot_schedule_id must be a positive integer");
      return detectPostOpComplications({ ot_schedule_id: id });
    },
    onSuccess: commonOnSuccess("Complication alert"),
    onError: commonOnError("Complication alert"),
  });

  const isPending =
    preop.isPending || consent.isPending || otNote.isPending || postOpInst.isPending ||
    risk.isPending || anaesthesia.isPending || implants.isPending || complications.isPending;

  const submit = () => {
    if (tab === "preop") preop.mutate();
    else if (tab === "consent") consent.mutate();
    else if (tab === "ot_note") otNote.mutate();
    else if (tab === "postop_inst") postOpInst.mutate();
    else if (tab === "risk") risk.mutate();
    else if (tab === "anaesthesia") anaesthesia.mutate();
    else if (tab === "implants") implants.mutate();
    else complications.mutate();
  };

  const canSubmit = !isPending && parsePositiveInt(scheduleId) != null;

  return (
    <section className="space-y-3">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Surgical / OR AI</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Drafts go to the clinical-AI review queue. Surgeons / anaesthetists sign off — never auto-finalised.
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
          <label className="space-y-1 text-sm lg:col-span-4">
            <span className="text-muted-foreground">OT Schedule ID</span>
            <input
              value={scheduleId}
              onChange={(e) => setScheduleId(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 42"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>

          {(tab === "consent" || tab === "postop_inst") ? (
            <label className="space-y-1 text-sm lg:col-span-3">
              <span className="text-muted-foreground">Language</span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as PatientExplainerLanguage)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </label>
          ) : null}

          {tab === "consent" ? (
            <label className="space-y-1 text-sm lg:col-span-12">
              <span className="text-muted-foreground">Patient comorbidities (comma-separated, optional)</span>
              <input
                value={comorbiditiesText}
                onChange={(e) => setComorbiditiesText(e.target.value)}
                placeholder="DM2, HTN, CKD-3, OSA"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
          ) : null}

          {tab === "ot_note" ? (
            <label className="space-y-1 text-sm lg:col-span-12">
              <span className="text-muted-foreground">Surgeon notes (free-text from the case)</span>
              <textarea
                value={surgeonNotes}
                onChange={(e) => setSurgeonNotes(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder="Standard 3-port lap; appendix retrocecal; no perforation; no peritonitis."
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
          ) : null}

          <div className="lg:col-span-4 flex items-end">
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

      {latest ? <SurgicalResult result={latest} /> : null}
    </section>
  );
}

function SurgicalResult({ result }: { result: SurgicalAiResult }) {
  const flags = Array.isArray(result.safety_flags) ? result.safety_flags : [];
  const critical = flags.filter((f) => String(f.severity || "").toLowerCase() === "critical");
  const high = flags.filter((f) => String(f.severity || "").toLowerCase() === "high");
  const draft = result.draft;
  const draftJson = JSON.stringify(draft, null, 2);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{result.module_key}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${reviewStatusClass(result.review_status)}`}>
          review: {result.review_status}
        </span>
        <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">{result.provider}</span>
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
        <span className="text-xs text-muted-foreground">case #{result.ot_schedule_id}</span>
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
        <div className="flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Draft (full JSON)</h3>
        </div>
        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed">
{draftJson}
        </pre>
      </div>

      {result.source_citations?.length ? (
        <div className="rounded-md border border-border p-2">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Source citations</p>
          <ul className="space-y-1 text-xs">
            {result.source_citations.map((citation, idx) => (
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

export default SurgicalAiPanel;
