"use client";

/* eslint-disable @typescript-eslint/no-unused-vars */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Activity,
  PlayCircle,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  getBedDischargeForecast,
  getPharmacyStockoutForecast,
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
  type BedDischargeForecast,
  type ChartGapRiskBand,
  type ClinicalTaskPriority,
  type DocumentIntake,
  type InfectionControlRiskBand,
  type PharmacyStockoutForecast,
  type PharmacyStockoutForecastItem,
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

export function ForecastWorkbenchPanel() {
  const [ward, setWard] = useState("");
  const [windowHours, setWindowHours] = useState("24");
  const [stockoutDays, setStockoutDays] = useState("7");
  const [bedForecast, setBedForecast] = useState<BedDischargeForecast | null>(null);
  const [pharmacyForecast, setPharmacyForecast] = useState<PharmacyStockoutForecast | null>(null);

  const bedWindow = Number.parseInt(windowHours.trim(), 10);
  const stockoutWindow = Number.parseInt(stockoutDays.trim(), 10);
  const canRunBedForecast = Number.isFinite(bedWindow) && bedWindow >= 1;
  const canRunStockoutForecast = Number.isFinite(stockoutWindow) && stockoutWindow >= 1;

  const beds = useMutation({
    mutationFn: () =>
      getBedDischargeForecast({
        ward: ward.trim() || undefined,
        windowHours: bedWindow,
      }),
    onSuccess: (result) => {
      setBedForecast(result);
      toast.success("Bed forecast refreshed");
    },
    onError: (err: Error) => toast.error(err.message || "Bed forecast failed"),
  });

  const pharmacy = useMutation({
    mutationFn: () => getPharmacyStockoutForecast(stockoutWindow),
    onSuccess: (result) => {
      setPharmacyForecast(result);
      toast.success("Stockout forecast refreshed");
    },
    onError: (err: Error) => toast.error(err.message || "Stockout forecast failed"),
  });

  const dischargeRows = bedForecast?.patients.slice(0, 6) ?? [];
  const stockoutRows: PharmacyStockoutForecastItem[] =
    pharmacyForecast?.stockout_risks.slice(0, 6) ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Capacity Forecasts</h2>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_8rem_auto] md:items-end">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Ward</span>
              <input
                value={ward}
                onChange={(event) => setWard(event.target.value)}
                placeholder="All wards"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Hours</span>
              <input
                value={windowHours}
                onChange={(event) => setWindowHours(event.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <button
              onClick={() => beds.mutate()}
              disabled={beds.isPending || !canRunBedForecast}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {beds.isPending ? "Forecasting..." : "Run Bed Forecast"}
            </button>
          </div>
          {bedForecast ? (
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Admitted</div>
                  <div className="text-xl font-semibold">{bedForecast.admitted_count}</div>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">24h Discharges</div>
                  <div className="text-xl font-semibold">{bedForecast.likely_discharges_24h}</div>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">48h Discharges</div>
                  <div className="text-xl font-semibold">{bedForecast.likely_discharges_48h}</div>
                </div>
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Bed</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Remaining</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {dischargeRows.length === 0 ? (
                      <tr>
                        <td className="px-3 py-5 text-center text-muted-foreground" colSpan={3}>
                          No admitted patients in scope
                        </td>
                      </tr>
                    ) : (
                      dischargeRows.map((patient) => (
                        <tr key={patient.admission_id}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{patient.bed_number ?? "-"}</div>
                            <div className="text-xs text-muted-foreground">{patient.ward ?? "-"}</div>
                          </td>
                          <td className="px-3 py-2">{patient.remaining_hours_estimate}h</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {patient.likely_discharge_24h ? (
                                <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                  24h
                                </span>
                              ) : null}
                              {patient.likely_discharge_48h ? (
                                <span className="rounded-full border border-cyan-200 bg-cyan-100 px-2 py-0.5 text-xs font-medium text-cyan-800">
                                  48h
                                </span>
                              ) : null}
                              {!patient.likely_discharge_48h ? (
                                <span className="text-xs text-muted-foreground">monitor</span>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Lookback days</span>
              <input
                value={stockoutDays}
                onChange={(event) => setStockoutDays(event.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <button
              onClick={() => pharmacy.mutate()}
              disabled={pharmacy.isPending || !canRunStockoutForecast}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {pharmacy.isPending ? "Forecasting..." : "Run Stockout Forecast"}
            </button>
          </div>
          {pharmacyForecast ? (
            <div className="mt-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">High Usage Meds</div>
                  <div className="text-xl font-semibold">{pharmacyForecast.high_usage_meds.length}</div>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Stockout Risks</div>
                  <div className="text-xl font-semibold">{pharmacyForecast.stockout_risks.length}</div>
                </div>
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Medication</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Orders</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Risk</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {stockoutRows.length === 0 ? (
                      <tr>
                        <td className="px-3 py-5 text-center text-muted-foreground" colSpan={3}>
                          No stockout risks in scope
                        </td>
                      </tr>
                    ) : (
                      stockoutRows.map((item) => (
                        <tr key={item.medication_name}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{item.medication_name}</div>
                            <div className="text-xs text-muted-foreground">{item.recommended_action}</div>
                          </td>
                          <td className="px-3 py-2">{item.order_count}</td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(item.risk_level)}`}>
                              {item.risk_level}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default ForecastWorkbenchPanel;
