"use client";

// Phase-2 clinical-AI panel. Tracker row 38 — voice_patient_assistant_ivr.
// Backend routes: apps/backend/src/routes/admin/clinicalAiRoutes.js (5063, 5081).
// Service:       apps/backend/src/services/ai/voicePatientAssistantIvrService.js (FINAL_DECISIONS = accepted|deferred|rejected|edited, rowsKey = 'sessions').

import { PhoneCall } from "lucide-react";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
  type KpiSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Row shape — mirrors normalizeSessionRow on the backend.
// ---------------------------------------------------------------------------
type VoiceSessionRow = {
  id: number;
  patient_uid: string | null;
  intent: string;
  channel: string;
  language: string | null;
  script_key: string | null;
  recommendation: string;
  severity: string;
  phi_leak_count: number;
  urgent_signal_count: number;
  reviewer_decision: string;
  created_at: string | null;
};

type VoiceDecision = "accepted" | "deferred" | "rejected" | "edited";

const INTENT_OPTIONS: { value: string; label: string }[] = [
  { value: "prep", label: "Prep" },
  { value: "aftercare", label: "Aftercare" },
  { value: "meds", label: "Meds" },
  { value: "reminder", label: "Reminder" },
  { value: "virtual_ward", label: "Virtual ward" },
  { value: "triage_callback", label: "Triage callback" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Unknown" },
];

const CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "ivr", label: "IVR" },
  { value: "phone", label: "Phone" },
  { value: "sms", label: "SMS" },
  { value: "chat", label: "Chat" },
  { value: "unknown", label: "Unknown" },
];

const RECOMMENDATION_OPTIONS: { value: string; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "escalate_to_clinician", label: "Escalate to clinician" },
  { value: "block", label: "Block" },
  { value: "fallback_to_human", label: "Fallback to human" },
  { value: "no_action", label: "No action" },
  { value: "unknown", label: "Unknown" },
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const DECISION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "edited", label: "Edited" },
];

const FILTERS: FilterSpec[] = [
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "Patient UID" },
  { key: "intent", label: "Intent", kind: "select", options: INTENT_OPTIONS },
  { key: "channel", label: "Channel", kind: "select", options: CHANNEL_OPTIONS },
  { key: "recommendation", label: "Recommendation", kind: "select", options: RECOMMENDATION_OPTIONS },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  { key: "reviewer_decision", label: "Review", kind: "select", options: DECISION_FILTER_OPTIONS },
];

function previewUid(uid: string | null): string {
  if (!uid) return "-";
  if (uid.length <= 10) return uid;
  return `${uid.slice(0, 8)}…`;
}

const KPIS: KpiSpec<VoiceSessionRow>[] = [
  {
    label: "Total",
    compute: (rows) => rows.length,
  },
  {
    label: "Critical + High",
    compute: (rows) =>
      rows.filter((row) => {
        const s = (row.severity || "").toLowerCase();
        return s === "critical" || s === "high";
      }).length,
  },
  {
    label: "PHI leaks",
    compute: (rows) =>
      rows.reduce((total, row) => total + (Number(row.phi_leak_count) || 0), 0),
  },
];

const COLUMNS: ColumnSpec<VoiceSessionRow>[] = [
  {
    key: "patient_uid",
    header: "Patient",
    render: (row) => (
      <span className="font-mono text-xs" title={row.patient_uid ?? undefined}>
        {previewUid(row.patient_uid)}
      </span>
    ),
  },
  {
    key: "intent",
    header: "Intent",
    render: (row) => readableKey(row.intent),
  },
  {
    key: "channel",
    header: "Channel",
    render: (row) => readableKey(row.channel),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    render: (row) => (
      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium">
        {readableKey(row.recommendation)}
      </span>
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
    key: "phi_leak_count",
    header: "PHI leaks",
    render: (row) =>
      row.phi_leak_count > 0 ? (
        <span className="font-mono text-xs text-red-700">{row.phi_leak_count}</span>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">0</span>
      ),
  },
  {
    key: "urgent_signal_count",
    header: "Urgent",
    render: (row) =>
      row.urgent_signal_count > 0 ? (
        <span className="font-mono text-xs text-orange-700">{row.urgent_signal_count}</span>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">0</span>
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

const DECIDE_ACTIONS: DecideAction<VoiceDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "edited", label: "Edit", variant: "primary", promptForNote: true },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
];

const BACKEND_PATH = "/admin/clinical-ai/voice-ivr/sessions";

export default function VoicePatientAssistantIvrPanel() {
  return (
    <ClinicalAIReviewQueue<VoiceSessionRow, VoiceDecision>
      title="Voice Patient Assistant (IVR)"
      moduleKey="voice_patient_assistant_ivr"
      icon={<PhoneCall className="h-4 w-4" />}
      description="Voice / IVR / SMS patient-assistant sessions (recommendation + PHI / urgent signals)."
      listFn={(params) => listClinicalAi(BACKEND_PATH, params)}
      rowsKey="sessions"
      decideFn={(id, decision, note) =>
        decideClinicalAi(BACKEND_PATH, id, decision, note)
      }
      filters={FILTERS}
      defaultFilters={{ reviewer_decision: "pending" }}
      columns={COLUMNS}
      decideActions={DECIDE_ACTIONS}
      kpis={KPIS}
      defaultLimit={50}
      emptyState="No voice/IVR sessions pending review"
    />
  );
}
