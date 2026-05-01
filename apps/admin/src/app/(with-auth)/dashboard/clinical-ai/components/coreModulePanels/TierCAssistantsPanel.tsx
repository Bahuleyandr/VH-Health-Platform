"use client";

/**
 * Tier C clinical-assistant admin panel — 16 P0/P1 modules registered
 * via migration 134, all wrapping `tierCAssistantsService`.
 *
 * High-stakes modules (renal/liver/pregnancy dose check, ADE detector,
 * AKI risk) carry critical-risk module-config flags requiring two-person
 * approval to enable per-tenant; this panel only exposes the generate
 * surface, sign-off + decisions live on the existing /reviews surface.
 */

import {
  AlertTriangle,
  ClipboardCheck,
  ClipboardList,
  FileText,
  HeartPulse,
  Hospital,
  Search,
  Stethoscope,
  Syringe,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const PATIENT = "11111111-1111-4111-8111-111111111111";

const MODULES: TierModule[] = [
  {
    key: "medical_certificate_draft",
    label: "Med cert",
    icon: FileText,
    endpoint: "/clinical-ai/medical-certificate-drafts",
    description: "Fitness / sickness / rest medical-certificate draft for a discharged admission.",
    body: { admission_id: 1, cert_type: "fitness", notes: "" },
  },
  {
    key: "clinic_letter_draft",
    label: "Clinic letter",
    icon: FileText,
    endpoint: "/clinical-ai/clinic-letter-drafts",
    description: "OPD/discharge consultation letter to a referring physician or relative.",
    body: { admission_id: 1, recipient_type: "referring_physician", letter_purpose: "post-admission summary" },
  },
  {
    key: "clinical_note_cleanup",
    label: "Note cleanup",
    icon: ClipboardCheck,
    endpoint: "/clinical-ai/clinical-note-cleanups",
    description: "Rewrites rough dictated/handwritten notes into a clean SOAP-ish structure.",
    body: {
      note_text: "Pt 65M, c/o sob x 3 days, worsening on exertion, no fever. Bp 145/85, hr 92. Crackles bilat bases. Likely chf exacerbation.",
      patient_uid: null,
      admission_id: null,
    },
  },
  {
    key: "missing_questions_assistant",
    label: "Missing Qs",
    icon: Search,
    endpoint: "/clinical-ai/missing-questions-suggestions",
    description: "Suggests follow-up history questions given chief complaint + age + comorbidities.",
    body: { chief_complaint: "chest pain", age_years: 58, comorbidities: ["diabetes", "hypertension"] },
  },
  {
    key: "missing_examination_assistant",
    label: "Missing exam",
    icon: Stethoscope,
    endpoint: "/clinical-ai/missing-examination-suggestions",
    description: "Suggests exam steps still to perform given working diagnosis.",
    body: { working_diagnosis: "suspected community-acquired pneumonia", exam_completed: ["temperature", "respiratory_rate"] },
  },
  {
    key: "missing_tests_assistant",
    label: "Missing tests",
    icon: ClipboardList,
    endpoint: "/clinical-ai/missing-tests-suggestions",
    description: "Suggests investigations not yet ordered given working diagnosis.",
    body: { working_diagnosis: "suspected pulmonary embolism", tests_ordered: ["d_dimer"] },
  },
  {
    key: "order_set_suggestion",
    label: "Order set",
    icon: ClipboardList,
    endpoint: "/clinical-ai/order-set-suggestions",
    description: "Suggests an order-set bundle (labs + imaging + meds) for a working diagnosis + acuity.",
    body: { working_diagnosis: "acute coronary syndrome", acuity: "urgent" },
  },
  {
    key: "renal_dose_check",
    label: "Renal dose",
    icon: TrendingDown,
    endpoint: "/clinical-ai/renal-dose-checks",
    description: "Reviews a prescription against eGFR/creatinine for renal dose-adjustment needs.",
    body: { prescription_id: 1, eGFR: 35, creatinine: 1.8 },
  },
  {
    key: "liver_dose_check",
    label: "Liver dose",
    icon: TrendingDown,
    endpoint: "/clinical-ai/liver-dose-checks",
    description: "Reviews a prescription for hepatic dose-adjustment given LFTs / Child-Pugh.",
    body: { prescription_id: 1, ast: 120, alt: 95, bilirubin: 2.4, child_pugh: "B" },
  },
  {
    key: "pregnancy_lactation_warning",
    label: "Pregnancy/lactation",
    icon: AlertTriangle,
    endpoint: "/clinical-ai/pregnancy-lactation-warnings",
    description: "Flags pregnancy/lactation safety concerns for prescribed medications.",
    body: { prescription_id: 1, pregnancy_status: "pregnant", lactation_status: null, trimester: 2 },
  },
  {
    key: "adverse_drug_event_detector",
    label: "ADE detector",
    icon: AlertTriangle,
    endpoint: "/clinical-ai/adverse-drug-event-detections",
    description: "Detects potential ADEs from a free-text symptom signal + the patient's active meds.",
    body: { patient_uid: PATIENT, signal: "rash and itching since starting amoxicillin 2 days ago" },
  },
  {
    key: "fall_risk_prediction",
    label: "Fall risk",
    icon: TrendingDown,
    endpoint: "/clinical-ai/fall-risk-predictions",
    description: "Composite fall-risk prediction (Morse / Hendrich-II / STRATIFY) for an admitted patient.",
    body: { patient_uid: PATIENT },
  },
  {
    key: "pressure_ulcer_risk_prediction",
    label: "Pressure ulcer",
    icon: HeartPulse,
    endpoint: "/clinical-ai/pressure-ulcer-risk-predictions",
    description: "Pressure-ulcer risk for an admission (Braden + mobility notes).",
    body: { patient_uid: PATIENT, admission_id: 1, braden_score: 14, mobility_notes: "limited; bedbound > 8h/day" },
  },
  {
    key: "aki_risk_alert",
    label: "AKI risk",
    icon: TrendingUp,
    endpoint: "/clinical-ai/aki-risk-alerts",
    description: "Acute kidney injury risk alert from recent labs + nephrotoxic exposure.",
    body: { patient_uid: PATIENT },
  },
  {
    key: "intake_output_summary",
    label: "I/O summary",
    icon: Syringe,
    endpoint: "/clinical-ai/intake-output-summaries",
    description: "Daily intake/output narrative for an admission.",
    body: { admission_id: 1, date: "2026-05-01" },
  },
  {
    key: "icu_round_summary",
    label: "ICU round",
    icon: Hospital,
    endpoint: "/clinical-ai/icu-round-summaries",
    description: "Full ICU round summary (state + plan), beyond the ventilator-bundle audit.",
    body: { admission_id: 1 },
  },
];

export function TierCAssistantsPanel() {
  return (
    <TierGenericPanel
      title="Tier C — P0/P1 clinical assistants"
      description="High-stakes modules (renal / liver / pregnancy dose check, ADE detector, AKI / fall / pressure-ulcer risk) require two-person approval to enable per-tenant. Drafts always require clinician sign-off."
      modules={MODULES}
    />
  );
}

export default TierCAssistantsPanel;
