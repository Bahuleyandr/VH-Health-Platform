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

export function AppealLetterGeneratorPanel() {
  const queryClient = useQueryClient();
  const [claimId, setClaimId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [denialReason, setDenialReason] = useState("");
  const [denialCode, setDenialCode] = useState("");
  const [appealType, setAppealType] = useState<AppealType>("first_level");
  const [claimFilter, setClaimFilter] = useState("");
  const [classificationFilter, setClassificationFilter] = useState<AppealDenialClassification | "">("");
  const [statusFilter, setStatusFilter] = useState<AppealLetterStatus | "">("");
  const [decisionFilter, setDecisionFilter] = useState<AppealLetterDecision | "">("pending");

  const appeals = useQuery({
    queryKey: ["clinical-ai", "appeal-letters", claimFilter, classificationFilter, statusFilter, decisionFilter],
    queryFn: () =>
      listAppealLetters({
        claimId: claimFilter.trim() || undefined,
        classification: classificationFilter || undefined,
        appealStatus: statusFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () =>
      generateAppealLetter({
        claimId: Number.parseInt(claimId.trim(), 10),
        admissionId: admissionId.trim() ? Number.parseInt(admissionId.trim(), 10) : undefined,
        denialReason: denialReason.trim() || undefined,
        denialCode: denialCode.trim() || undefined,
        appealType,
      }),
    onSuccess: (result) => {
      toast.success(`Appeal drafted: ${result.classification.classification.replace(/_/g, " ")}`);
      setClaimId("");
      setAdmissionId("");
      setDenialReason("");
      setDenialCode("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "appeal-letters"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Appeal generation failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: Exclude<AppealLetterDecision, "pending">; note?: string }) =>
      decideAppealLetter(id, decision, note),
    onSuccess: () => {
      toast.success("Appeal review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "appeal-letters"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Appeal review failed"),
  });
  const submit = useMutation({
    mutationFn: ({ id, ref }: { id: number; ref?: string }) => submitAppealLetter(id, ref),
    onSuccess: () => {
      toast.success("Appeal submitted to payer");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "appeal-letters"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Appeal submission failed"),
  });
  const payerResponse = useMutation({
    mutationFn: ({ id, status, note }: { id: number; status: "approved" | "denied" | "withdrawn"; note?: string }) =>
      recordAppealPayerResponse(id, status, { note }),
    onSuccess: () => {
      toast.success("Payer response recorded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "appeal-letters"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Payer response record failed"),
  });

  const rows: AppealLetter[] = appeals.data?.appeals ?? [];
  const submittedCount = rows.filter((row) => row.appeal_status === "submitted").length;
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const approvedCount = rows.filter((row) => row.appeal_status === "approved").length;
  const canGenerate = Number.isFinite(Number.parseInt(claimId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Appeal Letter Generator</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={claimFilter}
            onChange={(event) => setClaimFilter(event.target.value)}
            placeholder="claim id"
            inputMode="numeric"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <select
            value={classificationFilter}
            onChange={(event) => setClassificationFilter(event.target.value as AppealDenialClassification | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All denial types</option>
            {APPEAL_CLASSIFICATIONS.map((item) => (
              <option key={item} value={item}>{item.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as AppealLetterStatus | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All appeal status</option>
            {APPEAL_STATUSES.map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value as AppealLetterDecision | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All review</option>
            <option value="pending">pending</option>
            <option value="accepted">accepted</option>
            <option value="deferred">deferred</option>
            <option value="rejected">rejected</option>
            <option value="edited">edited</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Submitted</div>
          <div className="mt-1 text-2xl font-semibold text-blue-700">{submittedCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Approved</div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">{approvedCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingCount}</div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Claim ID</span>
            <input
              value={claimId}
              onChange={(event) => setClaimId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Admission ID (optional)</span>
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Denial reason</span>
            <input
              value={denialReason}
              onChange={(event) => setDenialReason(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Denial code / Appeal type</span>
            <div className="flex gap-2">
              <input
                value={denialCode}
                onChange={(event) => setDenialCode(event.target.value)}
                placeholder="code"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
              <select
                value={appealType}
                onChange={(event) => setAppealType(event.target.value as AppealType)}
                className="rounded-md border border-border bg-background px-2 py-2 text-sm"
              >
                {APPEAL_TYPES.map((type) => (
                  <option key={type} value={type}>{type.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          </label>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !canGenerate}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {generate.isPending ? "Drafting..." : "Draft Appeal"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Claim / Payer</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Denial</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Evidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Appeal status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No appeal letters found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.claim_number || `claim #${row.claim_id}`}</div>
                    <div className="text-xs text-muted-foreground">{row.insurance_provider || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    <div className="font-mono text-xs text-muted-foreground">appeal #{row.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium">
                      {row.denial_classification.replace(/_/g, " ")}
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">{row.appeal_type.replace(/_/g, " ")}</div>
                    {row.denial_reason ? (
                      <div className="mt-1 max-w-xs text-xs text-muted-foreground">{row.denial_reason}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xs space-y-1 text-xs">
                      <div>{(row.letter_draft?.procedure_codes || []).length} procedure code(s)</div>
                      <div>{(row.letter_draft?.diagnosis_codes || []).length} diagnosis code(s)</div>
                      <div className="text-muted-foreground">
                        {(row.source_citations || []).length} citations / {(row.safety_flags || []).length} safety flags
                      </div>
                      {(row.safety_flags || []).slice(0, 2).map((flag) => (
                        <div key={`${row.id}-${flag.code}`} className="flex items-center gap-1">
                          <span className={`rounded-full border px-2 py-0.5 font-medium ${severityBadgeClass(flag.severity)}`}>
                            {flag.severity}
                          </span>
                          <span>{flag.message}</span>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${appealStatusClass(row.appeal_status)}`}>
                      {row.appeal_status.replace(/_/g, " ")}
                    </span>
                    {row.submitted_at ? (
                      <div className="mt-1 text-xs text-muted-foreground">submitted {fmt(row.submitted_at)}</div>
                    ) : null}
                    {row.payer_response_at ? (
                      <div className="mt-1 text-xs text-muted-foreground">payer {fmt(row.payer_response_at)}</div>
                    ) : null}
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
                            const note = window.prompt("Edit note") ?? undefined;
                            decide.mutate({ id: row.id, decision: "edited", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                        >
                          Edit
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
                    ) : null}
                    {row.reviewer_decision === "accepted" && row.appeal_status === "ready_for_submission" ? (
                      <div className="mt-2">
                        <button
                          onClick={() => {
                            const ref = window.prompt("Payer reference ID (optional)") ?? undefined;
                            submit.mutate({ id: row.id, ref });
                          }}
                          disabled={submit.isPending}
                          className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                        >
                          Submit to payer
                        </button>
                      </div>
                    ) : null}
                    {row.appeal_status === "submitted" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => payerResponse.mutate({ id: row.id, status: "approved" })}
                          disabled={payerResponse.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Mark approved
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Denial reason") ?? undefined;
                            payerResponse.mutate({ id: row.id, status: "denied", note });
                          }}
                          disabled={payerResponse.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Mark denied
                        </button>
                        <button
                          onClick={() => payerResponse.mutate({ id: row.id, status: "withdrawn" })}
                          disabled={payerResponse.isPending}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Withdraw
                        </button>
                      </div>
                    ) : null}
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

export default AppealLetterGeneratorPanel;
