"use client";

/**
 * Tier D emergency / triage admin panel — 9 modules registered via
 * migration 135, all wrapping `tierDEmergencyService`. Each module
 * requires emergency-physician sign-off before any clinical action.
 */

import {
  Activity,
  AlertTriangle,
  Ambulance,
  ClipboardCheck,
  Clock,
  FileText,
  HeartPulse,
  ShieldAlert,
  Siren,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const PATIENT = "11111111-1111-4111-8111-111111111111";

const MODULES: TierModule[] = [
  {
    key: "emergency_triage_form_assistant",
    label: "Triage form",
    icon: ClipboardCheck,
    endpoint: "/clinical-ai/emergency-triage-forms",
    description: "Drafts an ED triage form from the registration-desk transcript.",
    body: {
      transcript: "55F brought by family for sudden onset chest pain since 30 minutes, sweating, nausea, prior MI 2 yrs ago.",
      age_years: 55,
      sex: "F",
    },
  },
  {
    key: "triage_priority_suggestion",
    label: "Priority",
    icon: Clock,
    endpoint: "/clinical-ai/triage-priority-suggestions",
    description: "Suggests ESI / Manchester / CTAS triage band given vitals + chief complaint.",
    body: {
      scale: "esi",
      vitals: { hr: 118, rr: 24, spo2: 91, sbp: 98 },
      chief_complaint: "shortness of breath x 1 day, chest tightness",
      age_years: 67,
      red_flags_observed: ["hypotension", "hypoxia"],
    },
  },
  {
    key: "ed_red_flag_detection",
    label: "ED red flags",
    icon: ShieldAlert,
    endpoint: "/clinical-ai/ed-red-flag-detections",
    description: "Specifically scans ED first-contact data for red flags (distinct from inpatient EWS).",
    body: {
      chief_complaint: "headache with neck stiffness, photophobia, fever 39.2",
      vitals: { temp: 39.2, hr: 110, sbp: 142 },
      age_years: 32,
    },
  },
  {
    key: "emergency_visit_summary",
    label: "ED summary",
    icon: FileText,
    endpoint: "/clinical-ai/emergency-visit-summaries",
    description: "Summary of an ED visit at disposition time, ready for discharge / admission handover.",
    body: { emergency_visit_id: 1 },
  },
  {
    key: "ambulance_handover_summary",
    label: "Ambulance handover",
    icon: Ambulance,
    endpoint: "/clinical-ai/ambulance-handover-summaries",
    description: "Structured handover from an ambulance dispatch into the ED.",
    body: { ambulance_request_id: 1 },
  },
  {
    key: "stroke_fast_check_assistant",
    label: "Stroke FAST",
    icon: AlertTriangle,
    endpoint: "/clinical-ai/stroke-fast-checks",
    description: "Stroke-FAST screening + thrombolysis-window check, drives stroke pathway.",
    body: {
      observations: { face_droop: true, arm_weakness: true, speech_slurring: true, time_of_onset: "2026-05-01T08:15:00Z" },
      patient_uid: PATIENT,
      emergency_visit_id: 1,
    },
  },
  {
    key: "chest_pain_protocol_assistant",
    label: "Chest pain",
    icon: HeartPulse,
    endpoint: "/clinical-ai/chest-pain-protocols",
    description: "Drives the ACS chest-pain protocol — risk stratification + bundle of orders.",
    body: {
      observations: { pain_character: "pressure", radiation: "left arm", duration_minutes: 45 },
      risk_factors: ["hypertension", "diabetes", "smoking"],
      ecg: "ST depression V4-V6",
      troponin: 0.18,
      patient_uid: PATIENT,
      emergency_visit_id: 1,
    },
  },
  {
    key: "trauma_checklist_assistant",
    label: "Trauma",
    icon: Siren,
    endpoint: "/clinical-ai/trauma-checklists",
    description: "ATLS-style trauma checklist for a poly-trauma activation.",
    body: {
      observations: { gcs: 13, sbp: 92, hr: 124, rr: 28 },
      mechanism: "high-speed RTA, ejected from vehicle",
      patient_uid: PATIENT,
      emergency_visit_id: 1,
    },
  },
  {
    key: "mlc_documentation_assistant",
    label: "MLC docs",
    icon: Activity,
    endpoint: "/clinical-ai/mlc-documentation",
    description: "Drafts the medico-legal case (MLC) documentation per Indian regs.",
    body: { mlc_record_id: 1 },
  },
];

export const TIER_D_EMERGENCY_MODULES = MODULES;

export function TierDEmergencyPanel() {
  return (
    <TierGenericPanel
      title="Tier D — Emergency / triage"
      description="Every module requires emergency-physician sign-off before any clinical action. Stroke / chest-pain / trauma drive their respective pathways but never auto-execute."
      modules={MODULES}
    />
  );
}

export default TierDEmergencyPanel;
