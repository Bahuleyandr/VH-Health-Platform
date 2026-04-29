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

export function ImagingAIPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [severityFilter, setSeverityFilter] = useState<ImagingSeverity | "">("");
  const [studyMode, setStudyMode] = useState<"pacs" | "manual">("pacs");
  const [patientUid, setPatientUid] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [studyUid, setStudyUid] = useState("");
  const [accessionNumber, setAccessionNumber] = useState("");
  const [studyProvider, setStudyProvider] = useState("orthanc");
  const [modality, setModality] = useState("XR");
  const [bodyPart, setBodyPart] = useState("CHEST");
  const [studyDate, setStudyDate] = useState(defaultDate(0));
  const [inferenceStudyUid, setInferenceStudyUid] = useState("");
  const [inferenceProvider, setInferenceProvider] = useState("local_model_runner");
  const [inferenceModel, setInferenceModel] = useState("vh-radiology-triage");
  const [inferenceModelVersion, setInferenceModelVersion] = useState("v1");
  const [heatmapUrl, setHeatmapUrl] = useState("");
  const [inferenceResults, setInferenceResults] = useState(DEFAULT_IMAGING_INFERENCE_RESULTS);
  const parsedInferenceResults = parseJsonArray<ImagingInferenceItem>(inferenceResults);
  const canSubmitStudy = studyMode === "pacs"
    ? Boolean(patientUid.trim() && (studyUid.trim() || accessionNumber.trim()))
    : Boolean(patientUid.trim() && studyUid.trim() && modality.trim());
  const canIngestInference = Boolean(inferenceStudyUid.trim() && inferenceProvider.trim() && parsedInferenceResults?.length);
  const pacsStatus = useQuery({
    queryKey: ["clinical-ai", "imaging", "pacs-status"],
    queryFn: () => getImagingPacsStatus(),
    staleTime: 60_000,
  });
  const findings = useQuery({
    queryKey: ["clinical-ai", "imaging", decisionFilter, severityFilter],
    queryFn: () =>
      listImagingFindings({
        decision: decisionFilter || undefined,
        severity: severityFilter || undefined,
      }),
  });
  const registerStudy = useMutation({
    mutationFn: () => {
      const admission = admissionId.trim();
      const body = bodyPart.trim();
      const source = studyProvider.trim();
      return registerImagingStudy({
        patient_uid: patientUid.trim(),
        study_instance_uid: studyUid.trim(),
        modality: modality.trim(),
        series_count: 1,
        instance_count: 1,
        source_system: source || "admin_console",
        metadata: { intake_surface: "admin_clinical_ai", intake_mode: "manual" },
        ...(admission ? { admission_id: admission } : {}),
        ...(body ? { body_part: body } : {}),
        ...(studyDate ? { study_date: studyDate } : {}),
      });
    },
    onSuccess: (study) => {
      toast.success("Imaging study registered");
      setInferenceStudyUid(study.study_instance_uid);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "imaging"] });
    },
    onError: (err: Error) => toast.error(err.message || "Study registration failed"),
  });
  const importStudy = useMutation({
    mutationFn: () => {
      const admission = admissionId.trim();
      const uid = studyUid.trim();
      const accession = accessionNumber.trim();
      const provider = studyProvider.trim();
      return importImagingStudyFromPacs({
        patient_uid: patientUid.trim(),
        metadata: { intake_surface: "admin_clinical_ai", intake_mode: "pacs" },
        ...(admission ? { admission_id: admission } : {}),
        ...(uid ? { study_instance_uid: uid } : {}),
        ...(accession ? { accession_number: accession } : {}),
        ...(provider ? { provider } : {}),
      });
    },
    onSuccess: (result) => {
      if (result.imported) {
        const importedUid = result.study?.study_instance_uid ?? studyUid.trim();
        if (importedUid) setInferenceStudyUid(importedUid);
        toast.success("PACS study imported");
      } else {
        toast(`PACS import skipped: ${result.reason ?? result.pacs_status}`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "imaging"] });
    },
    onError: (err: Error) => toast.error(err.message || "PACS import failed"),
  });
  const ingestInference = useMutation({
    mutationFn: () => {
      const parsed = parseJsonArray<ImagingInferenceItem>(inferenceResults);
      if (!parsed?.length) throw new Error("Inference results must be a non-empty JSON array");
      const model = inferenceModel.trim();
      const modelVersion = inferenceModelVersion.trim();
      const heatmap = heatmapUrl.trim();
      return ingestImagingInference({
        study_instance_uid: inferenceStudyUid.trim(),
        provider: inferenceProvider.trim(),
        results: parsed,
        raw_provider_payload: { intake_surface: "admin_clinical_ai" },
        ...(model ? { model } : {}),
        ...(modelVersion ? { model_version: modelVersion } : {}),
        ...(heatmap ? { heatmap_url: heatmap } : {}),
      });
    },
    onSuccess: (result) => {
      toast.success(`Inference ingested: ${result.overall_severity}`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "imaging"] });
    },
    onError: (err: Error) => toast.error(err.message || "Inference ingest failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "confirmed" | "revised" | "rejected" | "escalated"; note?: string }) =>
      decideImagingFinding(id, decision, note),
    onSuccess: () => {
      toast.success("Imaging finding decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "imaging"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: ImagingFinding[] = findings.data?.findings ?? [];
  const pacsStatusData = pacsStatus.data;
  const pacsBadgeClass = pacsStatusData?.configured
    ? "border-emerald-200 bg-emerald-100 text-emerald-800"
    : "border-amber-200 bg-amber-100 text-amber-800";
  const pacsLabel = pacsStatus.isLoading
    ? "Checking"
    : pacsStatusData?.configured
      ? "PACS ready"
      : "PACS off";

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Imaging AI — Radiologist Queue</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="revised">Revised</option>
            <option value="rejected">Rejected</option>
            <option value="escalated">Escalated</option>
            <option value="">All</option>
          </select>
          <select
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as ImagingSeverity | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">Any severity</option>
            <option value="critical">Critical</option>
            <option value="actionable">Actionable</option>
            <option value="incidental">Incidental</option>
            <option value="normal">Normal</option>
          </select>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Study intake</h3>
              <p className="text-xs text-muted-foreground">
                {pacsStatusData
                  ? `${pacsStatusData.provider ?? "pacs"} · ${pacsStatusData.api_mode ?? "adapter"}${pacsStatusData.reason ? ` · ${pacsStatusData.reason}` : ""}`
                  : "PACS adapter status pending"}
              </p>
            </div>
            <span className={`w-fit rounded-full border px-2 py-0.5 text-xs font-medium ${pacsBadgeClass}`}>{pacsLabel}</span>
          </div>
          <div className="mt-3 inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setStudyMode("pacs")}
              className={`rounded px-3 py-1 ${studyMode === "pacs" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              PACS
            </button>
            <button
              type="button"
              onClick={() => setStudyMode("manual")}
              className={`rounded px-3 py-1 ${studyMode === "manual" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              Manual
            </button>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Patient UID</span>
              <input
                value={patientUid}
                onChange={(event) => setPatientUid(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                placeholder="patient uuid"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Admission ID</span>
              <input
                value={admissionId}
                onChange={(event) => setAdmissionId(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                placeholder="optional"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Study UID</span>
              <input
                value={studyUid}
                onChange={(event) => {
                  setStudyUid(event.target.value);
                  setInferenceStudyUid(event.target.value);
                }}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                placeholder="study instance uid"
              />
            </label>
            {studyMode === "pacs" ? (
              <>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Accession</span>
                  <input
                    value={accessionNumber}
                    onChange={(event) => setAccessionNumber(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    placeholder="optional"
                  />
                </label>
                <label className="space-y-1 text-sm md:col-span-2">
                  <span className="text-muted-foreground">Provider</span>
                  <input
                    value={studyProvider}
                    onChange={(event) => setStudyProvider(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    placeholder="orthanc"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Modality</span>
                  <input
                    value={modality}
                    onChange={(event) => setModality(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    placeholder="XR"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Body part</span>
                  <input
                    value={bodyPart}
                    onChange={(event) => setBodyPart(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                    placeholder="CHEST"
                  />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">Study date</span>
                  <input
                    type="date"
                    value={studyDate}
                    onChange={(event) => setStudyDate(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                </label>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => (studyMode === "pacs" ? importStudy.mutate() : registerStudy.mutate())}
            disabled={!canSubmitStudy || importStudy.isPending || registerStudy.isPending}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {studyMode === "pacs" ? <CloudDownload className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {studyMode === "pacs" ? "Import study" : "Register study"}
          </button>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">Inference intake</h3>
              <p className="text-xs text-muted-foreground">External model output enters the radiologist review queue.</p>
            </div>
            <span className={`w-fit rounded-full border px-2 py-0.5 text-xs font-medium ${parsedInferenceResults ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-red-200 bg-red-100 text-red-800"}`}>
              {parsedInferenceResults ? "JSON valid" : "JSON invalid"}
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <label className="space-y-1 text-sm md:col-span-2">
              <span className="text-muted-foreground">Study UID</span>
              <input
                value={inferenceStudyUid}
                onChange={(event) => setInferenceStudyUid(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                placeholder="study instance uid"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Provider</span>
              <input
                value={inferenceProvider}
                onChange={(event) => setInferenceProvider(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Model</span>
              <input
                value={inferenceModel}
                onChange={(event) => setInferenceModel(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Version</span>
              <input
                value={inferenceModelVersion}
                onChange={(event) => setInferenceModelVersion(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Heatmap URL</span>
              <input
                value={heatmapUrl}
                onChange={(event) => setHeatmapUrl(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                placeholder="optional"
              />
            </label>
            <label className="space-y-1 text-sm md:col-span-2">
              <span className="text-muted-foreground">Results JSON</span>
              <textarea
                value={inferenceResults}
                onChange={(event) => setInferenceResults(event.target.value)}
                rows={5}
                className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => ingestInference.mutate()}
            disabled={!canIngestInference || ingestInference.isPending}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            Ingest inference
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Study</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Confidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No imaging findings awaiting this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${imagingSeverityClass(row.overall_severity)}`}>
                      {row.overall_severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.modality} · {row.body_part ?? "-"}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.study_instance_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid ?? ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    {row.findings.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {row.findings.slice(0, 3).map((f, idx) => (
                          <li key={idx}>
                            <span className="font-mono">{f.label}</span> — {(f.confidence * 100).toFixed(0)}%
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold">{row.confidence_pct ?? "-"}%</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.provider}{row.model ? ` · ${row.model}` : ""}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.radiologist_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "confirmed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Revision note") ?? undefined;
                            decide.mutate({ id: row.id, decision: "revised", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Revise
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "escalated" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Escalate
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.radiologist_decision}</span>
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

export default ImagingAIPanel;
