"use client";

/**
 * Tier A "fastest wins" assistant admin panel — 10 lightweight modules
 * registered via migration 133, all wrapping `tierAAssistantsService`.
 *
 * Patient-facing explainers (lab/radiology/report/prescription/invoice)
 * are in `PatientExplainersPanel` already; this panel covers the
 * staff-facing remainder.
 */

import {
  Activity,
  ClipboardList,
  FileSearch,
  FileText,
  HelpCircle,
  Mic,
  Pill,
  Phone,
  PenLine,
  ShieldCheck,
} from "lucide-react";

import TierGenericPanel, { type TierModule } from "./TierGenericPanel";

const MODULES: TierModule[] = [
  {
    key: "lab_trend_summary",
    label: "Lab trend",
    icon: Activity,
    endpoint: "/clinical-ai/lab-trend-summaries",
    description: "Per-analyte longitudinal trend summary for a patient.",
    body: { patient_uid: "11111111-1111-4111-8111-111111111111", analyte: "creatinine", window_days: 180, language: "en" },
  },
  {
    key: "discharge_medication_explanation",
    label: "Discharge meds",
    icon: Pill,
    endpoint: "/clinical-ai/discharge-medication-explanations",
    description: "Standalone discharge-medication explanation (carved out of aftercare).",
    body: { admission_id: 1, language: "en" },
  },
  {
    key: "patient_faq_assistant",
    label: "Patient FAQ",
    icon: HelpCircle,
    endpoint: "/clinical-ai/patient-faq-answers",
    description: "RAG-answered patient FAQ against a hospital knowledge base.",
    body: { query: "What time can visitors come in to the ICU?", knowledge_base_id: null, language: "en" },
  },
  {
    key: "lab_pending_result_reminder",
    label: "Lab pending",
    icon: ClipboardList,
    endpoint: "/clinical-ai/lab-pending-reminders",
    description: "Patient-friendly reminder that a pending lab result is due.",
    body: { patient_uid: "11111111-1111-4111-8111-111111111111", language: "en" },
  },
  {
    key: "front_desk_assistant",
    label: "Front desk",
    icon: ShieldCheck,
    endpoint: "/clinical-ai/front-desk-responses",
    description: "Text/web variant of the IVR; answers operational questions for the front desk.",
    body: { query: "How early should an MRI patient come in for the contrast prep?", knowledge_base_id: null, language: "en" },
  },
  {
    key: "audit_log_summary",
    label: "Audit summary",
    icon: FileSearch,
    endpoint: "/clinical-ai/audit-log-summaries",
    description: "RAG-style narrative summary over recent audit_logs (no PHI emitted).",
    body: { window_days: 7 },
  },
  {
    key: "call_summary",
    label: "Call summary",
    icon: Phone,
    endpoint: "/clinical-ai/call-summaries",
    description: "Concise summary of a recorded call transcript.",
    body: {
      transcript: "Receptionist: VH Health, this is Asha. Caller: Hi, I need to reschedule my appointment for tomorrow...",
      patient_uid: null,
      call_metadata: null,
      language: "en",
    },
  },
  {
    key: "handwritten_note_assistant",
    label: "Handwritten note",
    icon: PenLine,
    endpoint: "/clinical-ai/handwritten-note-structures",
    description: "Structures noisy OCR output of a handwritten note into a SOAP-ish layout.",
    body: {
      ocr_text: "Pt c/o headache 3/7. No fever. BP 130/85. R/O migraine. Start sumatriptan 50mg prn.",
      patient_uid: null,
      admission_id: null,
      ocr_confidence_map: null,
    },
  },
  {
    key: "voice_to_prescription_draft",
    label: "Voice to Rx",
    icon: Mic,
    endpoint: "/clinical-ai/voice-to-prescription-drafts",
    description: "Drafts a structured prescription from a doctor's voice transcript. Doctor co-signs.",
    body: {
      transcript: "Take amoxicillin 500 mg three times a day for seven days. Avoid alcohol. Follow up in two weeks.",
      patient_uid: null,
      doctor_uid: null,
    },
  },
  {
    key: "pending_report_tracker",
    label: "Pending reports",
    icon: FileText,
    endpoint: "/clinical-ai/pending-report-trackers",
    description: "Lists stale lab/radiology/discharge reports past their typical TAT, scoped to the tenant.",
    body: { stale_days: 7, scope: "all" },
  },
];

export function TierAAssistantsPanel() {
  return (
    <TierGenericPanel
      title="Tier A — Staff-facing assistants"
      description="Drafts go to the clinical-AI review queue keyed by module_key — sign-off lives on the existing /reviews surface."
      modules={MODULES}
    />
  );
}

export default TierAAssistantsPanel;
