"use client";

/* eslint-disable @typescript-eslint/no-unused-vars */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical,
  PlayCircle,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  deactivateCanaryCase,
  listCanaryCases,
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
  type AbnormalTriageBand,
  type AdmissionAiDraftModuleKey,
  type AntimicrobialStewardshipRiskBand,
  type AppealDenialClassification,
  type AppealLetterStatus,
  type AppealType,
  type FamilyCaregiverRelationship,
  type FamilyUpdateDecision,
  type FamilyUpdateLanguage,
  type FamilyUpdateStatus,
  type LabAutoverificationDecision,
  type LabAutoverificationReviewerDecision,
  type LabCriticalBand,
  type NursingAmbientDecision,
  type NursingAmbientShift,
  type PediatricDoseDecision,
  type PediatricSafetyBand,
  type StaffBurnoutDecision,
  type StaffBurnoutRiskBand,
  type PayerVarianceBand,
  type PayerVarianceCategory,
  type PayerVarianceDecision,
  type TeachBackDecision,
  type TeachBackLanguage,
  type TeachBackStatus,
  type CanaryBiasSeverity,
  type CanaryBiasSignal,
  type CanaryCase,
  type CanaryRunSummary,
  type CanarySliceAttributes,
  type CanarySliceMetric,
  type ChartGapRiskBand,
  type ClinicalTaskPriority,
  type DocumentIntake,
  type InfectionControlRiskBand,
  type PrivacySentinelRiskBand,
  type PriorAuthRequest,
  type RosterCoverageGap,
  type RosterPreferenceConflict,
  type SepsisBundleRiskBand,
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

function fmtMoneyMinor(value?: number | null) {
  if (value == null) return "-";
  return `₹${(Number(value) / 100).toLocaleString("en-IN")}`;
}

function fmtDuration(seconds?: number | null) {
  if (!seconds) return "-";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

const DEFAULT_CANARY_INPUT_PACKET = JSON.stringify(
  {
    citations: [
      {
        id: "synthetic-note-1",
        source: "sealed_canary_case",
        text: "Synthetic patient is afebrile, tolerating oral diet, and awaiting one repeat potassium result.",
      },
    ],
    chart: {
      diagnosis: "Synthetic community-acquired pneumonia",
      active_issues: ["repeat potassium pending"],
      allergies: ["penicillin rash"],
    },
  },
  null,
  2,
);

const DEFAULT_IMAGING_INFERENCE_RESULTS = JSON.stringify(
  [
    { label: "pneumonia", confidence: 0.82 },
    { label: "pleural_effusion", confidence: 0.64 },
  ],
  null,
  2,
);

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonArray<T = unknown>(value: string): T[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed as T[];
  } catch {
    return null;
  }
}

function splitCsvList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function severityBadgeClass(severity: string) {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function rosterStatusClass(status: string) {
  if (status === "published") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "discarded") return "bg-slate-100 text-slate-700 border-slate-200";
  if (status === "edited") return "bg-cyan-100 text-cyan-800 border-cyan-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

function defaultDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const DOCUMENT_SOURCE_TYPES = [
  "external_discharge_summary",
  "lab_report",
  "prescription",
  "referral_letter",
  "insurance_form",
  "abdm_document",
  "other",
];

function documentStatusClass(status: string) {
  if (status === "completed" || status === "accepted") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "failed" || status === "rejected") return "bg-red-100 text-red-800 border-red-200";
  if (status === "needs_review" || status === "needs_revision") return "bg-orange-100 text-orange-800 border-orange-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

function documentFactCount(row: DocumentIntake) {
  const fields = row.extracted_fields || {};
  return [
    fields.medications,
    fields.investigations,
    fields.diagnoses,
    fields.procedures,
    fields.follow_up,
  ].reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function documentOcrLabel(row: DocumentIntake) {
  const provider = typeof row.metadata?.ocr_provider === "string" ? row.metadata.ocr_provider : null;
  const status = typeof row.metadata?.ocr_status === "string" ? row.metadata.ocr_status : null;
  if (provider && status) return `${provider} / ${status}`;
  return provider || status || "text-first";
}

const CHART_RISK_BANDS: ChartGapRiskBand[] = ["critical", "high", "medium", "low"];
const TASK_PRIORITIES: ClinicalTaskPriority[] = ["critical", "urgent", "soon", "routine", "unknown"];
const PRIVACY_RISK_BANDS: PrivacySentinelRiskBand[] = ["critical", "high", "medium", "low"];
const ABNORMAL_TRIAGE_BANDS: AbnormalTriageBand[] = ["critical", "urgent", "watch", "routine"];
const INFECTION_RISK_BANDS: InfectionControlRiskBand[] = ["critical", "high", "medium", "low"];
const ANTIMICROBIAL_RISK_BANDS: AntimicrobialStewardshipRiskBand[] = ["critical", "high", "medium", "low"];
const APPEAL_STATUSES: AppealLetterStatus[] = [
  "draft",
  "ready_for_submission",
  "submitted",
  "approved",
  "denied",
  "withdrawn",
];
const APPEAL_TYPES: AppealType[] = ["first_level", "second_level", "external_review", "reconsideration"];
const APPEAL_CLASSIFICATIONS: AppealDenialClassification[] = [
  "medical_necessity",
  "prior_auth_missing",
  "documentation_insufficient",
  "coding_error",
  "duplicate_claim",
  "timely_filing",
  "bundled_service",
  "non_covered_service",
  "coverage",
  "other",
];

function appealStatusClass(status: string) {
  switch (status) {
    case "approved":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "denied":
      return "border-red-200 bg-red-50 text-red-800";
    case "withdrawn":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "submitted":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "ready_for_submission":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "draft":
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

const TEACH_BACK_STATUSES: TeachBackStatus[] = ["draft", "in_progress", "completed", "needs_clinician_review"];
const TEACH_BACK_LANGUAGES: TeachBackLanguage[] = ["en", "hi", "ta", "te", "ml", "mr", "bn", "kn"];
const TEACH_BACK_DECISIONS: TeachBackDecision[] = ["pending", "accepted", "deferred", "rejected"];

function teachBackStatusClass(status: string) {
  switch (status) {
    case "needs_clinician_review":
      return "border-orange-200 bg-orange-50 text-orange-800";
    case "in_progress":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "draft":
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}
const SEPSIS_RISK_BANDS: SepsisBundleRiskBand[] = ["critical", "high", "medium", "low"];

function chartRiskClass(risk: string) {
  if (risk === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (risk === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (risk === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  if (risk === "low") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function taskPriorityClass(priority: string) {
  if (priority === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (priority === "urgent") return "bg-orange-100 text-orange-800 border-orange-200";
  if (priority === "soon") return "bg-amber-100 text-amber-800 border-amber-200";
  if (priority === "routine") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function triageBandClass(band: string) {
  if (band === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (band === "urgent") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  if (band === "routine") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

const ADMISSION_DRAFT_MODULES: Array<{
  key: AdmissionAiDraftModuleKey;
  label: string;
  owner: string;
}> = [
  { key: "patient_record_summary", label: "Patient Summary", owner: "Doctor" },
  { key: "patient_aftercare_instructions", label: "Aftercare", owner: "Doctor" },
  { key: "medication_reconciliation", label: "Med Reconciliation", owner: "Pharmacist" },
  { key: "discharge_readiness", label: "Readiness", owner: "Care team" },
  { key: "referral_letter", label: "Referral Letter", owner: "Doctor" },
  { key: "clinical_coding_assist", label: "Coding Assist", owner: "Coder" },
  { key: "quality_case_review", label: "Quality Review", owner: "Quality" },
];

function formatDraftValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "-";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Document Intelligence / OCR
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Admission AI Drafts
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Chart Completion Auditor
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Clinical Task Extractor
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Abnormal Result Triage Worklist
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Infection Control Sentinel
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Antimicrobial Stewardship Assistant
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// AI ROI Dashboard
// ---------------------------------------------------------------------------
function formatMinor(value: number) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value / 100);
}

function fmtNumber(value?: number | null) {
  if (value === null || value === undefined) return "0";
  return new Intl.NumberFormat("en-IN").format(value);
}

function formatMinutes(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}



// ---------------------------------------------------------------------------
// Appeal Letter Generator for Denied Claims
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Lab Autoverification / Delta Check
// ---------------------------------------------------------------------------
const LAB_DECISIONS: LabAutoverificationDecision[] = ["pending", "auto_verify", "hold_for_review", "critical", "rejected"];
const LAB_REVIEWER_DECISIONS: LabAutoverificationReviewerDecision[] = ["pending", "accepted", "deferred", "rejected", "edited"];
const LAB_CRITICAL_BANDS: LabCriticalBand[] = ["normal", "borderline_low", "borderline_high", "critical_low", "critical_high", "unknown"];

function labDecisionClass(decision: string) {
  switch (decision) {
    case "critical":
      return "border-red-200 bg-red-50 text-red-800";
    case "hold_for_review":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "auto_verify":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "rejected":
      return "border-slate-200 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function labBandClass(band: string) {
  switch (band) {
    case "critical_low":
    case "critical_high":
      return "border-red-200 bg-red-50 text-red-800";
    case "borderline_low":
    case "borderline_high":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "normal":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}



// ---------------------------------------------------------------------------
// Pediatric Dosing Safety AI
// ---------------------------------------------------------------------------
const PEDIATRIC_SAFETY_BANDS: PediatricSafetyBand[] = ["safe", "caution", "unsafe", "missing_data", "unknown"];
const PEDIATRIC_DECISIONS: PediatricDoseDecision[] = ["pending", "accepted", "deferred", "rejected", "edited"];

function pediatricSafetyClass(band: string) {
  switch (band) {
    case "unsafe":
      return "border-red-200 bg-red-50 text-red-800";
    case "caution":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "safe":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "missing_data":
      return "border-slate-200 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}



// ---------------------------------------------------------------------------
// Payer Contract Variance / Underpayment AI
// ---------------------------------------------------------------------------
const PAYER_VARIANCE_DECISIONS: PayerVarianceDecision[] = ["pending", "accepted", "deferred", "rejected", "escalated"];
const PAYER_VARIANCE_CATEGORIES: PayerVarianceCategory[] = [
  "match", "underpayment", "overpayment", "missing_contract", "missing_payment",
];
const PAYER_VARIANCE_BANDS: PayerVarianceBand[] = ["within_tolerance", "review", "investigate", "escalate"];

function payerVarianceBandClass(band: string) {
  switch (band) {
    case "escalate":
      return "border-red-200 bg-red-50 text-red-800";
    case "investigate":
      return "border-orange-200 bg-orange-50 text-orange-800";
    case "review":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "within_tolerance":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}



// ---------------------------------------------------------------------------
// Patient Teach-Back / Comprehension AI
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Sepsis Bundle Sentinel
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Consent & PHI Policy Sentinel
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Prompt A/B Experiments
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Drift Canary
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Capacity Forecasts
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Operational Predictions
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Charge Capture Audits
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Deterioration Early Warning
// ---------------------------------------------------------------------------
function deteriorationBandClass(band: string) {
  if (band === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (band === "concerning") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}



// ---------------------------------------------------------------------------
// Polypharmacy Reviews
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Clinical Trial Catalog Sync (ClinicalTrials.gov v2)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Clinical Trial Matches
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// RCA Drafts
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Prior Authorization
// ---------------------------------------------------------------------------
function priorAuthStatusClass(status: string) {
  if (status === "approved") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "denied") return "bg-red-100 text-red-800 border-red-200";
  if (status === "submitted") return "bg-blue-100 text-blue-800 border-blue-200";
  if (status === "withdrawn") return "bg-slate-100 text-slate-700 border-slate-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

function priorAuthSubmissionLabel(row: PriorAuthRequest) {
  const submission = row.metadata?.payer_submission;
  if (!submission || typeof submission !== "object") return null;
  if (submission.payer_status) return String(submission.payer_status);
  if (submission.status === "manual_submission_required") return "Manual";
  if (submission.reason) return String(submission.reason).replaceAll("_", " ");
  return submission.status ? String(submission.status) : null;
}



// ---------------------------------------------------------------------------
// Imaging AI (radiology_ai_interpretation)
// ---------------------------------------------------------------------------
function imagingSeverityClass(severity: string) {
  if (severity === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (severity === "actionable") return "bg-orange-100 text-orange-800 border-orange-200";
  if (severity === "incidental") return "bg-amber-100 text-amber-800 border-amber-200";
  if (severity === "unreadable") return "bg-slate-200 text-slate-900 border-slate-300";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}



// ---------------------------------------------------------------------------
// Virtual ward
// ---------------------------------------------------------------------------
function virtualWardSeverityClass(severity: string) {
  if (severity === "red") return "bg-red-200 text-red-900 border-red-300";
  if (severity === "amber") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}



// ---------------------------------------------------------------------------
// Consent-Aware Family Update Generator
// ---------------------------------------------------------------------------
const FAMILY_RELATIONSHIPS: FamilyCaregiverRelationship[] = [
  "spouse", "parent", "child", "sibling", "friend", "legal_guardian", "guardian", "care_manager", "other",
];
const FAMILY_LANGUAGES: FamilyUpdateLanguage[] = ["en", "hi", "ta", "te", "ml", "mr", "bn", "kn"];
const FAMILY_STATUSES: FamilyUpdateStatus[] = ["draft", "ready_to_send", "sent", "withdrawn"];
const FAMILY_DECISIONS: FamilyUpdateDecision[] = ["pending", "accepted", "deferred", "rejected", "edited"];

function familyStatusClass(status: string) {
  switch (status) {
    case "sent":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "ready_to_send":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "withdrawn":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "draft":
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}



// ---------------------------------------------------------------------------
// Nursing Ambient Documentation
// ---------------------------------------------------------------------------
const NURSING_AMBIENT_SHIFTS: NursingAmbientShift[] = ["day", "evening", "night", "custom"];
const NURSING_AMBIENT_DECISIONS: NursingAmbientDecision[] = ["pending", "accepted", "deferred", "rejected", "edited"];



// ---------------------------------------------------------------------------
// Ambient clinical documentation
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Staff roster optimizer
// ---------------------------------------------------------------------------
function RosterFindingsList({
  gaps,
  conflicts,
}: {
  gaps: RosterCoverageGap[];
  conflicts: RosterPreferenceConflict[];
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Gap</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Needed</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Short</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {gaps.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={3}>
                  No coverage gaps
                </td>
              </tr>
            ) : (
              gaps.slice(0, 8).map((gap) => (
                <tr key={`${gap.date}-${gap.shift_code}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{gap.date}</div>
                    <div className="text-xs text-muted-foreground">{gap.shift_code}</div>
                  </td>
                  <td className="px-4 py-3">{gap.filled} / {gap.needed}</td>
                  <td className="px-4 py-3 font-semibold text-amber-700">{gap.shortfall}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Staff</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Assigned</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Prefers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {conflicts.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={3}>
                  No preference conflicts
                </td>
              </tr>
            ) : (
              conflicts.slice(0, 8).map((conflict) => (
                <tr key={`${conflict.staff_uid}-${conflict.date}-${conflict.shift_code}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{conflict.staff_name ?? "-"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{conflict.staff_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{conflict.date}</div>
                    <div className="text-xs text-muted-foreground">{conflict.shift_code}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">{conflict.preferred.join(", ") || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff Burnout / Workload Risk Predictor
// ---------------------------------------------------------------------------
const STAFF_BURNOUT_RISK_BANDS: StaffBurnoutRiskBand[] = ["low", "moderate", "high", "critical", "insufficient_data", "unknown"];
const STAFF_BURNOUT_DECISIONS: StaffBurnoutDecision[] = ["pending", "accepted", "deferred", "rejected", "escalated"];

function staffBurnoutBandClass(band: string) {
  switch (band) {
    case "critical":
      return "border-red-200 bg-red-50 text-red-800";
    case "high":
      return "border-orange-200 bg-orange-50 text-orange-800";
    case "moderate":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "low":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "insufficient_data":
      return "border-slate-200 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}





// Re-export a single header for the section in page.tsx.

function biasSeverityClass(severity: CanaryBiasSeverity) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-900";
  if (severity === "high") return "border-orange-200 bg-orange-50 text-orange-900";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function buildSliceAttributes(values: {
  age_band: string;
  sex: string;
  language: string;
  disease_group: string;
  facility_id: string;
}): CanarySliceAttributes {
  const attrs: CanarySliceAttributes = {};
  for (const [key, raw] of Object.entries(values)) {
    const trimmed = raw.trim();
    if (trimmed) attrs[key] = trimmed;
  }
  return attrs;
}

export function DriftCanaryPanel() {
  const queryClient = useQueryClient();
  const [caseModuleKey, setCaseModuleKey] = useState("discharge_summary");
  const [caseLabel, setCaseLabel] = useState("");
  const [expectedKeys, setExpectedKeys] = useState("hospital_course, discharge_diagnosis");
  const [expectedCitationsMin, setExpectedCitationsMin] = useState("1");
  const [inputPacket, setInputPacket] = useState(() => DEFAULT_CANARY_INPUT_PACKET);
  // S3 demographic-slice tagging — keeps the bias-monitoring schema's axes
  // in sync with what the UI exposes to the AI eval lead.
  const [sliceAgeBand, setSliceAgeBand] = useState("");
  const [sliceSex, setSliceSex] = useState("");
  const [sliceLanguage, setSliceLanguage] = useState("");
  const [sliceDiseaseGroup, setSliceDiseaseGroup] = useState("");
  const [sliceFacilityId, setSliceFacilityId] = useState("");
  const runs = useQuery({
    queryKey: ["clinical-ai", "canary", "runs"],
    queryFn: () => listCanaryRuns(),
  });
  const cases = useQuery({
    queryKey: ["clinical-ai", "canary", "cases"],
    queryFn: () => listCanaryCases({ limit: 100 }),
  });
  const canaryCases: CanaryCase[] = cases.data?.cases ?? [];
  const activeCaseCount = canaryCases.filter((item) => item.active).length;
  const expectedCitationNumber = Number.parseInt(expectedCitationsMin.trim(), 10);
  const parsedPacket = parseJsonObject(inputPacket);
  const canSaveCase = Boolean(
    caseModuleKey.trim()
    && caseLabel.trim()
    && parsedPacket
    && Number.isFinite(expectedCitationNumber)
    && expectedCitationNumber >= 1,
  );
  const run = useMutation({
    mutationFn: () => runCanary(),
    onSuccess: (result) => {
      if (result.drift_detected) {
        toast.error(`Drift detected — ${result.pass_count}/${result.total_cases} cases passed`);
      } else {
        toast.success(`Canary clean — ${result.pass_count}/${result.total_cases} cases passed`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "canary", "runs"] });
    },
    onError: (err: Error) => toast.error(err.message || "Canary run failed"),
  });
  const saveCase = useMutation({
    mutationFn: () => {
      const packet = parseJsonObject(inputPacket);
      if (!packet) throw new Error("Input packet must be a JSON object");
      return upsertCanaryCase({
        module_key: caseModuleKey.trim(),
        label: caseLabel.trim(),
        input_packet: packet,
        expected_keys: splitCsvList(expectedKeys),
        expected_citations_min: expectedCitationNumber,
        slice_attributes: buildSliceAttributes({
          age_band: sliceAgeBand,
          sex: sliceSex,
          language: sliceLanguage,
          disease_group: sliceDiseaseGroup,
          facility_id: sliceFacilityId,
        }),
      });
    },
    onSuccess: () => {
      toast.success("Canary case saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "canary", "cases"] });
    },
    onError: (err: Error) => toast.error(err.message || "Canary case save failed"),
  });
  const deactivate = useMutation({
    mutationFn: (id: number) => deactivateCanaryCase(id),
    onSuccess: () => {
      toast.success("Canary case deactivated");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "canary", "cases"] });
    },
    onError: (err: Error) => toast.error(err.message || "Canary case update failed"),
  });
  const rows: CanaryRunSummary[] = runs.data?.runs ?? [];
  const latest = rows[0];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Model Drift Canary</h2>
        </div>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending || activeCaseCount === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {run.isPending ? "Running…" : "Run Canary"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sealed synthetic test set; alerts when pass-rate drops &ge;10pp vs the last good baseline.
      </p>
      {latest?.drift_detected ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <strong>Drift detected</strong> on the latest run — {latest.pass_count} of {latest.total_cases} cases passed. Review prompts or providers.
        </div>
      ) : null}
      {Array.isArray(latest?.bias_signals) && latest.bias_signals.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
          <div className="font-semibold">
            Bias signals — {latest.bias_signals.length} demographic slice
            {latest.bias_signals.length === 1 ? "" : "s"} underperforming overall.
          </div>
          <ul className="space-y-1 text-xs">
            {latest.bias_signals.slice(0, 6).map((signal: CanaryBiasSignal) => (
              <li
                key={`${signal.axis}-${signal.value}`}
                className={`rounded border px-2 py-1 ${biasSeverityClass(signal.severity)}`}
              >
                <span className="font-mono uppercase text-[0.65rem] tracking-wide">{signal.severity}</span>{" "}
                <strong>{signal.axis}={signal.value}</strong> — {signal.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {Array.isArray(latest?.slice_metrics) && latest.slice_metrics.length ? (
        <div className="rounded-lg border border-border bg-card p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Latest slice breakdown</h3>
            <span className="text-xs text-muted-foreground">
              {latest.slice_metrics.length} slices across age / sex / language / disease group / facility
            </span>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Axis</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Value</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Pass / total</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Pass rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {latest.slice_metrics.slice(0, 30).map((slice: CanarySliceMetric) => (
                  <tr key={`${slice.axis}-${slice.value}`}>
                    <td className="px-3 py-1.5 font-mono">{slice.axis}</td>
                    <td className="px-3 py-1.5">{slice.value}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">
                      {slice.pass_count} / {slice.sample_count}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {slice.pass_rate_pct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Canary Cases</h3>
            <p className="text-xs text-muted-foreground">{activeCaseCount} active / {canaryCases.length} total</p>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${parsedPacket ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-red-200 bg-red-100 text-red-800"}`}>
            {parsedPacket ? "JSON valid" : "JSON invalid"}
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-6">
          <label className="space-y-1 text-sm lg:col-span-2">
            <span className="text-muted-foreground">Module key</span>
            <input
              value={caseModuleKey}
              onChange={(event) => setCaseModuleKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-2">
            <span className="text-muted-foreground">Case label</span>
            <input
              value={caseLabel}
              onChange={(event) => setCaseLabel(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Expected keys</span>
            <input
              value={expectedKeys}
              onChange={(event) => setExpectedKeys(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Min citations</span>
            <input
              type="number"
              min={1}
              value={expectedCitationsMin}
              onChange={(event) => setExpectedCitationsMin(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-6">
            <span className="text-muted-foreground">Input packet JSON</span>
            <textarea
              value={inputPacket}
              onChange={(event) => setInputPacket(event.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            />
          </label>
          <div className="lg:col-span-6 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">
              Demographic slice (optional) — used by bias monitoring
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Age band</span>
                <input
                  value={sliceAgeBand}
                  onChange={(event) => setSliceAgeBand(event.target.value)}
                  placeholder="pediatric / adult / geriatric"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Sex</span>
                <input
                  value={sliceSex}
                  onChange={(event) => setSliceSex(event.target.value)}
                  placeholder="M / F / other"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Language</span>
                <input
                  value={sliceLanguage}
                  onChange={(event) => setSliceLanguage(event.target.value)}
                  placeholder="en / hi / ta / ..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Disease group</span>
                <input
                  value={sliceDiseaseGroup}
                  onChange={(event) => setSliceDiseaseGroup(event.target.value)}
                  placeholder="cardiac / oncology / ..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-muted-foreground">Facility</span>
                <input
                  value={sliceFacilityId}
                  onChange={(event) => setSliceFacilityId(event.target.value)}
                  placeholder="facility id / code"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:col-span-6">
            <button
              onClick={() => saveCase.mutate()}
              disabled={saveCase.isPending || !canSaveCase}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saveCase.isPending ? "Saving..." : "Save Case"}
            </button>
            <span className="text-xs text-muted-foreground">
              {canSaveCase ? "Case draft ready" : "Case draft incomplete"}
            </span>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Case</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Expected</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {canaryCases.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                    No canary cases yet.
                  </td>
                </tr>
              ) : (
                canaryCases.slice(0, 50).map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-mono text-xs">{row.module_key}</td>
                    <td className="px-4 py-3">{row.label}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {(row.expected_keys || []).join(", ") || "-"} / {row.expected_citations_min} citation
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.active ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-700"}`}>
                        {row.active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                    <td className="px-4 py-3">
                      {row.active ? (
                        <button
                          onClick={() => deactivate.mutate(row.id)}
                          disabled={deactivate.isPending}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Deactivate
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scope</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Cases</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pass / Fail</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Drift</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No runs yet.
                </td>
              </tr>
            ) : (
              rows.slice(0, 20).map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-xs">{row.run_scope}</td>
                  <td className="px-4 py-3">{row.total_cases}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.pass_count} pass / {row.fail_count} fail
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.drift_detected ? "bg-red-100 text-red-800 border-red-200" : "bg-emerald-100 text-emerald-800 border-emerald-200"}`}>
                      {row.drift_detected ? "drift" : "clean"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.started_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default DriftCanaryPanel;
