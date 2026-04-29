"use client";

/* eslint-disable @typescript-eslint/no-unused-vars */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Beaker,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  CloudDownload,
  DollarSign,
  FileSearch,
  FlaskConical,
  Heart,
  Image,
  ListChecks,
  Microscope,
  Mic2,
  Pill,
  PlayCircle,
  Receipt,
  Save,
  Stethoscope,
  TrendingUp,
  Trash2,
  UsersRound,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  acknowledgeVirtualWardEscalation,
  deactivateCanaryCase,
  decideChartCompletionAudit,
  decideClinicalAiTask,
  decideInfectionControlAudit,
  decideAntimicrobialStewardshipReview,
  decideAppealLetter,
  decideFamilyUpdate,
  decideLabAutoverification,
  decideNursingAmbientSession,
  decidePayerVarianceReview,
  decidePediatricDoseCheck,
  decideStaffBurnoutReview,
  decideTeachBackSession,
  getAiRoiMetrics,
  getLatestAiRoiSnapshot,
  decidePrivacySentinelAudit,
  decideSepsisBundleAudit,
  concludePromptExperiment,
  decideChargeCaptureAudit,
  decideDocumentIntake,
  decideImagingFinding,
  decidePolypharmacyReview,
  discardRosterRun,
  decideRcaDraft,
  decideTrialMatch,
  generateAdmissionAiDraft,
  generateAbnormalResultTriage,
  generateChartCompletionAudit,
  extractClinicalAiTasks,
  generateInfectionControlAudit,
  evaluateClaimVariance,
  evaluateLabAutoverification,
  evaluatePediatricDose,
  evaluateStaffBurnout,
  generateAntimicrobialStewardshipReview,
  generateAppealLetter,
  generateFamilyUpdate,
  generateTeachBackSession,
  generatePriorAuthorization,
  generateRcaDraft,
  generateRosterSuggestion,
  generateSepsisBundleAudit,
  getBedDischargeForecast,
  getImagingPacsStatus,
  getPharmacyStockoutForecast,
  importImagingStudyFromPacs,
  ingestDocumentIntake,
  ingestImagingInference,
  listAbnormalResultTriages,
  listAmbientEncounters,
  listCanaryCases,
  listCanaryRuns,
  listChartCompletionAudits,
  listClinicalAiTasks,
  listChargeCaptureAudits,
  listDeteriorationSnapshots,
  listDocumentIntakes,
  listImagingFindings,
  listInfectionControlAudits,
  listAntimicrobialStewardshipReviews,
  listAppealLetters,
  listFamilyUpdates,
  listLabAutoverifications,
  listNursingAmbientSessions,
  listPayerContracts,
  listPayerVarianceReviews,
  listPediatricDoseChecks,
  listStaffBurnoutReviews,
  listTeachBackSessions,
  listAiRoiSnapshots,
  markFamilyUpdateSent,
  recordAppealPayerResponse,
  saveAiRoiSnapshot,
  submitAppealLetter,
  upsertPayerContract,
  listPolypharmacyReviews,
  listPrivacySentinelAudits,
  listPriorAuthorizations,
  listPromptExperiments,
  listRcaDrafts,
  listRosterRuns,
  listSepsisBundleAudits,
  listTrialMatches,
  listTrialSyncRuns,
  listVirtualWardEnrollments,
  listVirtualWardEscalations,
  matchPatientAgainstTrials,
  predictOtCaseTime,
  publishRosterRun,
  recordPriorAuthPayerDecision,
  registerImagingStudy,
  resolveVirtualWardEscalation,
  runCanary,
  runPrivacySentinelScan,
  scoreNoShowRisk,
  submitPriorAuthorization,
  triggerTrialCatalogSync,
  upsertCanaryCase,
  uploadDocumentIntake,
  type AbnormalResultTriageDraft,
  type AbnormalTriageBand,
  type AdmissionAiDraftModuleKey,
  type AmbientEncounter,
  type AiRoiByModule,
  type AiRoiMetrics,
  type AiRoiSnapshot,
  type AntimicrobialStewardshipDecision,
  type AntimicrobialStewardshipReview,
  type AntimicrobialStewardshipRiskBand,
  type AppealDenialClassification,
  type AppealLetter,
  type AppealLetterDecision,
  type AppealLetterStatus,
  type AppealType,
  type FamilyCaregiverRelationship,
  type FamilyUpdate,
  type FamilyUpdateDecision,
  type FamilyUpdateLanguage,
  type FamilyUpdateStatus,
  type LabAutoverification,
  type LabAutoverificationDecision,
  type LabAutoverificationReviewerDecision,
  type LabCriticalBand,
  type NursingAmbientDecision,
  type NursingAmbientSession,
  type NursingAmbientShift,
  type PayerContract,
  type PediatricDoseCheck,
  type PediatricDoseDecision,
  type PediatricSafetyBand,
  type StaffBurnoutDecision,
  type StaffBurnoutRiskBand,
  type StaffBurnoutReview,
  type PayerVarianceBand,
  type PayerVarianceCategory,
  type PayerVarianceDecision,
  type PayerVarianceReview,
  type TeachBackDecision,
  type TeachBackLanguage,
  type TeachBackSession,
  type TeachBackStatus,
  type BedDischargeForecast,
  type CanaryCase,
  type CanaryRunSummary,
  type ChartCompletionAudit,
  type ChartGapRiskBand,
  type ChargeCaptureAudit,
  type ClinicalAiTaskCandidate,
  type ClinicalTaskDecision,
  type ClinicalTaskPriority,
  type ClinicalAiDraftResponse,
  type DeteriorationBand,
  type DeteriorationSnapshot,
  type DocumentIntake,
  type ImagingFinding,
  type ImagingInferenceItem,
  type ImagingSeverity,
  type InfectionControlAudit,
  type InfectionControlRiskBand,
  type NoShowRiskPrediction,
  type OtCaseTimePrediction,
  type PharmacyStockoutForecast,
  type PharmacyStockoutForecastItem,
  type PolypharmacyReview,
  type PrivacySentinelAudit,
  type PrivacySentinelRiskBand,
  type PriorAuthRequest,
  type PromptExperiment,
  type RcaCaseType,
  type RcaDraftSummary,
  type RosterCoverageGap,
  type RosterPreferenceConflict,
  type RosterRun,
  type RosterSuggestion,
  type SepsisBundleAudit,
  type SepsisBundleRiskBand,
  type TrialMatch,
  type TrialSyncRun,
  type VirtualWardEnrollment,
  type VirtualWardEscalation,
  type VirtualWardSeverity,
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

export function AntimicrobialStewardshipPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState<AntimicrobialStewardshipRiskBand | "">("");
  const [decisionFilter, setDecisionFilter] = useState<AntimicrobialStewardshipDecision | "">("pending");

  const reviews = useQuery({
    queryKey: ["clinical-ai", "antimicrobial-stewardship", admissionFilter, riskFilter, decisionFilter],
    queryFn: () =>
      listAntimicrobialStewardshipReviews({
        admissionId: admissionFilter.trim() || undefined,
        riskBand: riskFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () => generateAntimicrobialStewardshipReview(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(`Stewardship review: ${result.draft.risk_band} risk`);
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "antimicrobial-stewardship"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Stewardship review failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: Exclude<AntimicrobialStewardshipDecision, "pending">; note?: string }) =>
      decideAntimicrobialStewardshipReview(id, decision, note),
    onSuccess: () => {
      toast.success("Stewardship review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "antimicrobial-stewardship"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Stewardship review failed"),
  });

  const rows: AntimicrobialStewardshipReview[] = reviews.data?.reviews ?? [];
  const criticalOrHigh = rows.filter((row) => row.risk_band === "critical" || row.risk_band === "high").length;
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const averageScore = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.stewardship_score, 0) / rows.length)
    : 0;
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Pill className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Antimicrobial Stewardship</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={admissionFilter}
            onChange={(event) => setAdmissionFilter(event.target.value)}
            placeholder="admission"
            inputMode="numeric"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <select
            value={riskFilter}
            onChange={(event) => setRiskFilter(event.target.value as AntimicrobialStewardshipRiskBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All risk</option>
            {ANTIMICROBIAL_RISK_BANDS.map((band) => (
              <option key={band} value={band}>{band}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value as AntimicrobialStewardshipDecision | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All review</option>
            <option value="pending">pending</option>
            <option value="accepted">accepted</option>
            <option value="deferred">deferred</option>
            <option value="rejected">rejected</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Average score</div>
          <div className="mt-1 text-2xl font-semibold">{averageScore}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical / high</div>
          <div className="mt-1 text-2xl font-semibold text-orange-700">{criticalOrHigh}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingCount}</div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Admission ID</span>
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !canGenerate}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {generate.isPending ? "Reviewing..." : "Run Review"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Antibiotics</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Flags</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No stewardship reviews found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    <div className="font-mono text-xs text-muted-foreground">review #{row.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.stewardship_score}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(row.risk_band)}`}>
                      {row.risk_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-sm space-y-1 text-xs">
                      {(row.antibiotic_summary || []).slice(0, 3).map((item, index) => (
                        <div key={`${row.id}-abx-${index}`}>
                          <span className="font-medium">{item.antibiotic}</span>
                          <span className="text-muted-foreground"> {item.route || "-"} / {item.duration || "no duration"}</span>
                        </div>
                      ))}
                      {(row.antibiotic_summary || []).length > 3 ? (
                        <div className="text-muted-foreground">+{row.antibiotic_summary.length - 3} more</div>
                      ) : null}
                      <div className="text-muted-foreground">{(row.culture_summary || []).length} culture item(s)</div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xl space-y-1 text-xs">
                      {(row.flags || []).slice(0, 4).map((flag) => (
                        <div key={`${row.id}-${flag.code}`} className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 font-medium ${severityBadgeClass(flag.severity)}`}>
                            {flag.severity}
                          </span>
                          <span>{flag.title}</span>
                        </div>
                      ))}
                      {(row.flags || []).length > 4 ? (
                        <div className="text-muted-foreground">+{row.flags.length - 4} more</div>
                      ) : null}
                      <div className="text-muted-foreground">
                        {(row.source_citations || []).length} citations / {(row.safety_flags || []).length} safety flags
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    {row.reviewer_decision === "pending" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Defer reason") ?? undefined;
                            decide.mutate({ id: row.id, decision: "deferred", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Defer
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Reject reason") ?? undefined;
                            decide.mutate({ id: row.id, decision: "rejected", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">{fmt(row.reviewed_at)}</div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default AntimicrobialStewardshipPanel;
