"use client";

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
  generateAntimicrobialStewardshipReview,
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
  type AbnormalResultTriageDraft,
  type AbnormalTriageBand,
  type AdmissionAiDraftModuleKey,
  type AmbientEncounter,
  type AntimicrobialStewardshipDecision,
  type AntimicrobialStewardshipReview,
  type AntimicrobialStewardshipRiskBand,
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
} from "@/lib/api/emr";

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

const CHART_RISK_BANDS: ChartGapRiskBand[] = ["critical", "high", "medium", "low"];
const TASK_PRIORITIES: ClinicalTaskPriority[] = ["critical", "urgent", "soon", "routine", "unknown"];
const PRIVACY_RISK_BANDS: PrivacySentinelRiskBand[] = ["critical", "high", "medium", "low"];
const ABNORMAL_TRIAGE_BANDS: AbnormalTriageBand[] = ["critical", "urgent", "watch", "routine"];
const INFECTION_RISK_BANDS: InfectionControlRiskBand[] = ["critical", "high", "medium", "low"];
const ANTIMICROBIAL_RISK_BANDS: AntimicrobialStewardshipRiskBand[] = ["critical", "high", "medium", "low"];
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
export function DocumentIntelligencePanel() {
  const queryClient = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [patientFilter, setPatientFilter] = useState("");
  const [sourceType, setSourceType] = useState("external_discharge_summary");
  const [patientUid, setPatientUid] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [rawText, setRawText] = useState("");

  const documents = useQuery({
    queryKey: ["clinical-ai", "documents", sourceFilter, decisionFilter, patientFilter],
    queryFn: () =>
      listDocumentIntakes({
        sourceType: sourceFilter || undefined,
        decision: decisionFilter || undefined,
        patientUid: patientFilter.trim() || undefined,
        limit: 50,
      }),
  });
  const ingest = useMutation({
    mutationFn: () => {
      const parsedAdmissionId = admissionId.trim()
        ? Number.parseInt(admissionId.trim(), 10)
        : NaN;
      return ingestDocumentIntake({
        source_type: sourceType,
        patient_uid: patientUid.trim() || null,
        admission_id: Number.isFinite(parsedAdmissionId) ? parsedAdmissionId : null,
        title: title.trim() || null,
        file_name: fileName.trim() || null,
        raw_text: rawText,
      });
    },
    onSuccess: (result) => {
      toast.success(result.intake_id ? "Document intake saved" : "Document extracted without intake table");
      setRawText("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "documents"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Document intake failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "accepted" | "rejected" | "needs_revision" }) =>
      decideDocumentIntake(id, decision),
    onSuccess: () => {
      toast.success("Document review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "documents"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Review failed"),
  });

  const rows: DocumentIntake[] = documents.data?.documents ?? [];
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const safetyFlagCount = rows.reduce((sum, row) => sum + (row.safety_flags?.length || 0), 0);
  const extractedFactCount = rows.reduce((sum, row) => sum + documentFactCount(row), 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Document Intelligence / OCR</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={patientFilter}
            onChange={(event) => setPatientFilter(event.target.value)}
            placeholder="patient uid"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All sources</option>
            {DOCUMENT_SOURCE_TYPES.map((source) => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="needs_revision">Needs revision</option>
            <option value="rejected">Rejected</option>
            <option value="">All decisions</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Extracted facts</div>
          <div className="mt-1 text-2xl font-semibold">{extractedFactCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Safety flags</div>
          <div className="mt-1 text-2xl font-semibold text-amber-700">{safetyFlagCount}</div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-6">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Source</span>
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {DOCUMENT_SOURCE_TYPES.map((source) => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm lg:col-span-2">
            <span className="text-muted-foreground">Patient UID</span>
            <input
              value={patientUid}
              onChange={(event) => setPatientUid(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Admission</span>
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-2">
            <span className="text-muted-foreground">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">File name</span>
            <input
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm lg:col-span-3">
            <span className="text-muted-foreground">OCR / extracted text</span>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <div className="flex items-end lg:col-span-6">
            <button
              onClick={() => ingest.mutate()}
              disabled={ingest.isPending || !rawText.trim()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {ingest.isPending ? "Extracting..." : "Extract Draft"}
            </button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Document</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Extraction</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Safety</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No document intakes found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.title || row.file_name || row.document_type}</div>
                    <div className="text-xs text-muted-foreground">{row.source_type} / {fmt(row.created_at)}</div>
                    {row.generation_id ? (
                      <div className="font-mono text-xs text-muted-foreground">gen #{row.generation_id}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    {row.admission_id ? <div className="text-xs text-muted-foreground">admission #{row.admission_id}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.extraction_status)}`}>
                        {row.extraction_status}
                      </span>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
                        {documentFactCount(row)} facts
                      </span>
                      {row.extracted_fields?.confidence ? (
                        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
                          {row.extracted_fields.confidence}% confidence
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {row.document_type} / {row.source_citations?.length || 0} citations
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.safety_flags?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {row.safety_flags.slice(0, 3).map((flag, idx) => (
                          <span key={`${flag.code}-${idx}`} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(flag.severity)}`}>
                            {flag.code}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">none</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "needs_revision" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
                        >
                          Revise
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{fmt(row.reviewed_at)}</span>
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

// ---------------------------------------------------------------------------
// Admission AI Drafts
// ---------------------------------------------------------------------------
export function AdmissionAiDraftWorkbenchPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [runningModule, setRunningModule] = useState<AdmissionAiDraftModuleKey | null>(null);
  const [result, setResult] = useState<ClinicalAiDraftResponse | null>(null);

  const parsedAdmissionId = Number.parseInt(admissionId.trim(), 10);
  const canGenerate = Number.isFinite(parsedAdmissionId);
  const resultModule = ADMISSION_DRAFT_MODULES.find((module) => module.key === result?.module_key);
  const citations = result?.source_citations ?? [];
  const safetyFlags = result?.safety_flags ?? [];

  const generate = useMutation({
    mutationFn: (moduleKey: AdmissionAiDraftModuleKey) => generateAdmissionAiDraft(parsedAdmissionId, moduleKey),
    onSuccess: (draft) => {
      setResult(draft);
      toast.success("Admission draft queued for review");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Admission draft failed"),
    onSettled: () => setRunningModule(null),
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <FileSearch className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Admission AI Drafts</h2>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-[16rem_1fr] lg:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Admission ID</span>
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {ADMISSION_DRAFT_MODULES.map((module) => {
              const isRunning = generate.isPending && runningModule === module.key;
              return (
                <button
                  key={module.key}
                  onClick={() => {
                    setRunningModule(module.key);
                    generate.mutate(module.key);
                  }}
                  disabled={generate.isPending || !canGenerate}
                  className="inline-flex min-h-12 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  <span>
                    <span className="block">{isRunning ? "Generating..." : module.label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">{module.owner}</span>
                  </span>
                  <PlayCircle className="h-4 w-4 shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {result ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm text-muted-foreground">{resultModule?.owner ?? "Clinical review"}</div>
                <div className="text-lg font-semibold">{resultModule?.label ?? result.module_key}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(result.review_status)}`}>
                  {result.review_status}
                </span>
                {result.requires_signoff ? (
                  <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    signoff
                  </span>
                ) : null}
              </div>
            </div>
            <pre className="max-h-[30rem] overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-foreground">
              {formatDraftValue(result.draft)}
            </pre>
          </div>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="text-sm font-medium">Generation</div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">ID</dt>
                  <dd className="font-mono">{result.generation_id ?? "-"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Review</dt>
                  <dd className="font-mono">{result.review_id ?? "-"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Prompt</dt>
                  <dd>{result.prompt_version}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Provider</dt>
                  <dd>{result.ai_metadata?.provider ?? "template"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Fallback</dt>
                  <dd>{result.ai_metadata?.fallback_reason ?? "-"}</dd>
                </div>
              </dl>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-sm font-medium">Safety Flags</div>
              <div className="flex flex-wrap gap-1">
                {safetyFlags.length ? (
                  safetyFlags.slice(0, 8).map((flag, index) => (
                    <span
                      key={`${flag.code}-${index}`}
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(flag.severity)}`}
                    >
                      {flag.code}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">none</span>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-sm font-medium">Citations</div>
              <div className="space-y-2">
                {citations.length ? (
                  citations.slice(0, 6).map((citation, index) => (
                    <div key={`${citation.source_type}-${citation.source_id ?? index}`} className="rounded-md border border-border bg-background p-2">
                      <div className="text-sm font-medium">{citation.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {citation.source_type} / {citation.source_id ?? "-"}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">No citations returned</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Chart Completion Auditor
// ---------------------------------------------------------------------------
export function ChartCompletionPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState<ChartGapRiskBand | "">("");
  const [decisionFilter, setDecisionFilter] = useState("pending");

  const audits = useQuery({
    queryKey: ["clinical-ai", "chart-completion", admissionFilter, riskFilter, decisionFilter],
    queryFn: () =>
      listChartCompletionAudits({
        admissionId: admissionFilter.trim() || undefined,
        riskBand: riskFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () => generateChartCompletionAudit(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(result.audit_id ? "Chart completion audit generated" : "Chart audit generated without audit table");
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "chart-completion"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Chart audit failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "accepted" | "deferred" | "rejected" }) =>
      decideChartCompletionAudit(id, decision),
    onSuccess: () => {
      toast.success("Chart audit review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "chart-completion"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Review failed"),
  });

  const rows: ChartCompletionAudit[] = audits.data?.audits ?? [];
  const highRiskCount = rows.filter((row) => row.risk_band === "critical" || row.risk_band === "high").length;
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const avgScore = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.completion_score, 0) / rows.length)
    : 0;
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Chart Completion Auditor</h2>
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
            onChange={(event) => setRiskFilter(event.target.value as ChartGapRiskBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All risk</option>
            {CHART_RISK_BANDS.map((risk) => (
              <option key={risk} value={risk}>{risk}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="deferred">Deferred</option>
            <option value="rejected">Rejected</option>
            <option value="">All decisions</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Average score</div>
          <div className="mt-1 text-2xl font-semibold">{avgScore}%</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">High risk</div>
          <div className="mt-1 text-2xl font-semibold text-orange-700">{highRiskCount}</div>
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
            {generate.isPending ? "Auditing..." : "Run Audit"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top gaps</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Safety</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No chart completion audits found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    {row.generation_id ? <div className="font-mono text-xs text-muted-foreground">gen #{row.generation_id}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.completion_score}%</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(row.risk_band)}`}>
                      {row.risk_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-xl flex-wrap gap-1">
                      {row.blockers.slice(0, 4).map((gap) => (
                        <span key={gap.code} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(gap.severity)}`}>
                          {gap.code}
                        </span>
                      ))}
                      {row.blockers.length === 0 ? <span className="text-xs text-muted-foreground">none</span> : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {row.source_citations?.length || 0} citations / {row.gap_summary?.gap_counts?.total ?? row.blockers.length} gaps
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.safety_flags?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {row.safety_flags.slice(0, 3).map((flag, idx) => (
                          <span key={`${flag.code}-${idx}`} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(flag.severity)}`}>
                            {flag.code}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">none</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">{fmt(row.created_at)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "deferred" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Defer
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{fmt(row.reviewed_at)}</span>
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

// ---------------------------------------------------------------------------
// Clinical Task Extractor
// ---------------------------------------------------------------------------
export function ClinicalTaskExtractorPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<ClinicalTaskPriority | "">("");
  const [decisionFilter, setDecisionFilter] = useState<ClinicalTaskDecision | "">("pending");

  const tasks = useQuery({
    queryKey: ["clinical-ai", "tasks", admissionFilter, priorityFilter, decisionFilter],
    queryFn: () =>
      listClinicalAiTasks({
        admissionId: admissionFilter.trim() || undefined,
        priority: priorityFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 75,
      }),
  });
  const extract = useMutation({
    mutationFn: () => extractClinicalAiTasks(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(`Task extraction generated: ${result.task_count} candidate(s)`);
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "tasks"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Task extraction failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: Exclude<ClinicalTaskDecision, "pending"> }) =>
      decideClinicalAiTask(id, decision),
    onSuccess: () => {
      toast.success("Task review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "tasks"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Task review failed"),
  });

  const rows: ClinicalAiTaskCandidate[] = tasks.data?.tasks ?? [];
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const urgentCount = rows.filter((row) => row.priority === "critical" || row.priority === "urgent").length;
  const acceptedCount = rows.filter((row) => row.reviewer_decision === "accepted" || row.reviewer_decision === "completed").length;
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Clinical Task Extractor</h2>
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
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as ClinicalTaskPriority | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All priority</option>
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value as ClinicalTaskDecision | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="deferred">Deferred</option>
            <option value="completed">Completed</option>
            <option value="rejected">Rejected</option>
            <option value="">All decisions</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical / urgent</div>
          <div className="mt-1 text-2xl font-semibold text-orange-700">{urgentCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Accepted / done</div>
          <div className="mt-1 text-2xl font-semibold">{acceptedCount}</div>
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
            onClick={() => extract.mutate()}
            disabled={extract.isPending || !canGenerate}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {extract.isPending ? "Extracting..." : "Extract Tasks"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Task</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Priority</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Owner</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Evidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                  No task candidates found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id ?? "-"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    {row.generation_id ? <div className="font-mono text-xs text-muted-foreground">gen #{row.generation_id}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-md font-medium">{row.task_title}</div>
                    {row.task_description ? (
                      <div className="mt-1 max-w-md text-xs text-muted-foreground">{row.task_description}</div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs">
                        {row.category}
                      </span>
                      {row.due_hint ? (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                          {row.due_hint}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${taskPriorityClass(row.priority)}`}>
                      {row.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.owner_role || "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.metadata?.no_auto_assign ? "review queue" : "draft"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      {row.source_citations?.slice(0, 2).map((citation, index) => (
                        <div key={`${citation.source_type}-${citation.source_id ?? index}`} className="max-w-xs text-xs">
                          <div className="font-medium">{citation.label}</div>
                          <div className="font-mono text-muted-foreground">
                            {citation.source_type} / {citation.source_id ?? "-"}
                          </div>
                        </div>
                      ))}
                      {row.source_citations?.length ? null : <span className="text-xs text-muted-foreground">none</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">{fmt(row.created_at)}</div>
                    {row.safety_flags?.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.safety_flags.slice(0, 2).map((flag, index) => (
                          <span key={`${flag.code}-${index}`} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(flag.severity)}`}>
                            {flag.code}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "deferred" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Defer
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : row.reviewer_decision === "accepted" || row.reviewer_decision === "deferred" ? (
                      <button
                        onClick={() => decide.mutate({ id: row.id, decision: "completed" })}
                        disabled={decide.isPending}
                        className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        Complete
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{fmt(row.reviewed_at)}</span>
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

// ---------------------------------------------------------------------------
// Abnormal Result Triage Worklist
// ---------------------------------------------------------------------------
export function AbnormalResultTriagePanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [bandFilter, setBandFilter] = useState<AbnormalTriageBand | "">("");

  const triages = useQuery({
    queryKey: ["clinical-ai", "abnormal-result-triage", admissionFilter, bandFilter],
    queryFn: () =>
      listAbnormalResultTriages({
        admissionId: admissionFilter.trim() || undefined,
        urgencyBand: bandFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () => generateAbnormalResultTriage(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(`Abnormal triage generated: ${(result.draft?.urgent_items || []).length} urgent item(s)`);
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "abnormal-result-triage"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Abnormal result triage failed"),
  });

  const rows: AbnormalResultTriageDraft[] = triages.data?.drafts ?? [];
  const urgentCount = rows.filter((row) => row.summary.urgency_band === "critical" || row.summary.urgency_band === "urgent").length;
  const watchCount = rows.filter((row) => row.summary.urgency_band === "watch").length;
  const pendingReviewCount = rows.filter((row) => (row.review_status || "pending") === "pending").length;
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Abnormal Result Triage</h2>
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
            value={bandFilter}
            onChange={(event) => setBandFilter(event.target.value as AbnormalTriageBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All urgency</option>
            {ABNORMAL_TRIAGE_BANDS.map((band) => (
              <option key={band} value={band}>{band}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical / urgent</div>
          <div className="mt-1 text-2xl font-semibold text-orange-700">{urgentCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Watch</div>
          <div className="mt-1 text-2xl font-semibold">{watchCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingReviewCount}</div>
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
            {generate.isPending ? "Triaging..." : "Run Triage"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Urgency</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top Signals</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Evidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No abnormal result triage drafts found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id || "-"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    <div className="font-mono text-xs text-muted-foreground">gen #{row.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.summary.urgency_score}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${triageBandClass(row.summary.urgency_band)}`}>
                      {row.summary.urgency_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xl space-y-1 text-xs">
                      {row.summary.top_urgent.map((item, idx) => (
                        <div key={`u-${idx}`} className="text-orange-800">
                          {item.source || "urgent"}: {(item.abnormalities || []).join(", ") || item.note || "-"}
                        </div>
                      ))}
                      {row.summary.top_watch.map((item, idx) => (
                        <div key={`w-${idx}`} className="text-muted-foreground">
                          {item.source || "watch"}: {item.note || (item.abnormalities || []).join(", ") || "-"}
                        </div>
                      ))}
                      {!row.summary.top_urgent.length && !row.summary.top_watch.length ? (
                        <span className="text-muted-foreground">No abnormal signals in draft</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">
                      {(row.citations || []).length} citations / {(row.safety_flags || []).length} safety flags
                    </div>
                    <div className="text-xs text-muted-foreground">{row.provider} / {row.used_ai ? "AI" : "rule"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.review_status || "pending")}`}>
                      {row.review_status || "pending"}
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">{fmt(row.created_at)}</div>
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

// ---------------------------------------------------------------------------
// Infection Control Sentinel
// ---------------------------------------------------------------------------
export function InfectionControlSentinelPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState<InfectionControlRiskBand | "">("");
  const [decisionFilter, setDecisionFilter] = useState("pending");

  const audits = useQuery({
    queryKey: ["clinical-ai", "infection-control", admissionFilter, riskFilter, decisionFilter],
    queryFn: () =>
      listInfectionControlAudits({
        admissionId: admissionFilter.trim() || undefined,
        riskBand: riskFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () => generateInfectionControlAudit(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(`Infection-control audit: ${result.draft.risk_band} risk`);
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "infection-control"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Infection-control audit failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "acknowledged" | "escalated" | "dismissed" }) =>
      decideInfectionControlAudit(id, decision),
    onSuccess: () => {
      toast.success("Infection-control review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "infection-control"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Infection-control review failed"),
  });

  const rows: InfectionControlAudit[] = audits.data?.audits ?? [];
  const criticalOrHigh = rows.filter((row) => row.risk_band === "critical" || row.risk_band === "high").length;
  const stewardshipCount = rows.reduce((sum, row) => sum + (row.stewardship_flags?.length || 0), 0);
  const isolationCount = rows.reduce((sum, row) => sum + (row.isolation_flags?.length || 0), 0);
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Microscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Infection Control Sentinel</h2>
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
            onChange={(event) => setRiskFilter(event.target.value as InfectionControlRiskBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All risk</option>
            {INFECTION_RISK_BANDS.map((band) => (
              <option key={band} value={band}>{band}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All review</option>
            <option value="pending">pending</option>
            <option value="acknowledged">acknowledged</option>
            <option value="escalated">escalated</option>
            <option value="dismissed">dismissed</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical / high</div>
          <div className="mt-1 text-2xl font-semibold text-orange-700">{criticalOrHigh}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Stewardship flags</div>
          <div className="mt-1 text-2xl font-semibold">{stewardshipCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Isolation flags</div>
          <div className="mt-1 text-2xl font-semibold text-red-700">{isolationCount}</div>
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
            {generate.isPending ? "Scanning..." : "Run Sentinel"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Risk</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Signals</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Evidence</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No infection-control audits found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    <div className="font-mono text-xs text-muted-foreground">audit #{row.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.risk_score}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(row.risk_band)}`}>
                      {row.risk_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xl space-y-1 text-xs">
                      {(row.signals || []).slice(0, 4).map((signal) => (
                        <div key={`${row.id}-${signal.code}`} className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 font-medium ${severityBadgeClass(signal.severity)}`}>
                            {signal.severity}
                          </span>
                          <span>{signal.title}</span>
                        </div>
                      ))}
                      {(row.signals || []).length > 4 ? (
                        <div className="text-muted-foreground">+{row.signals.length - 4} more</div>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">
                      {(row.source_citations || []).length} citations / {(row.safety_flags || []).length} safety flags
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {(row.stewardship_flags || []).length} stewardship / {(row.isolation_flags || []).length} isolation
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{fmt(row.created_at)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    {row.reviewer_decision === "pending" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "acknowledged" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "escalated" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
                        >
                          Escalate
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "dismissed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Dismiss
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

// ---------------------------------------------------------------------------
// Antimicrobial Stewardship Assistant
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Sepsis Bundle Sentinel
// ---------------------------------------------------------------------------
export function SepsisBundleSentinelPanel() {
  const queryClient = useQueryClient();
  const [admissionId, setAdmissionId] = useState("");
  const [admissionFilter, setAdmissionFilter] = useState("");
  const [riskFilter, setRiskFilter] = useState<SepsisBundleRiskBand | "">("");
  const [decisionFilter, setDecisionFilter] = useState("pending");

  const audits = useQuery({
    queryKey: ["clinical-ai", "sepsis-bundle", admissionFilter, riskFilter, decisionFilter],
    queryFn: () =>
      listSepsisBundleAudits({
        admissionId: admissionFilter.trim() || undefined,
        riskBand: riskFilter || undefined,
        decision: decisionFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () => generateSepsisBundleAudit(Number.parseInt(admissionId.trim(), 10)),
    onSuccess: (result) => {
      toast.success(`Sepsis bundle audit: ${result.draft.risk_band} risk`);
      setAdmissionId("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "sepsis-bundle"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "reviews"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "usage"] });
    },
    onError: (err: Error) => toast.error(err.message || "Sepsis bundle audit failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "acknowledged" | "escalated" | "dismissed" }) =>
      decideSepsisBundleAudit(id, decision),
    onSuccess: () => {
      toast.success("Sepsis bundle review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "sepsis-bundle"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai-audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Sepsis bundle review failed"),
  });

  const rows: SepsisBundleAudit[] = audits.data?.audits ?? [];
  const criticalOrHigh = rows.filter((row) => row.risk_band === "critical" || row.risk_band === "high").length;
  const gapCount = rows.reduce((sum, row) => sum + (row.bundle_gaps?.length || 0), 0);
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;
  const canGenerate = Number.isFinite(Number.parseInt(admissionId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Sepsis Bundle Sentinel</h2>
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
            onChange={(event) => setRiskFilter(event.target.value as SepsisBundleRiskBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All risk</option>
            {SEPSIS_RISK_BANDS.map((band) => (
              <option key={band} value={band}>{band}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All review</option>
            <option value="pending">pending</option>
            <option value="acknowledged">acknowledged</option>
            <option value="escalated">escalated</option>
            <option value="dismissed">dismissed</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical / high</div>
          <div className="mt-1 text-2xl font-semibold text-red-700">{criticalOrHigh}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Bundle gaps</div>
          <div className="mt-1 text-2xl font-semibold">{gapCount}</div>
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
            {generate.isPending ? "Auditing..." : "Run Bundle Audit"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Risk</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Criteria</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Bundle Gaps</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No sepsis bundle audits found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">admission #{row.admission_id}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.patient_uid || "-"}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                    <div className="font-mono text-xs text-muted-foreground">audit #{row.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.risk_score}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(row.risk_band)}`}>
                      {row.risk_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xl space-y-1 text-xs">
                      {(row.criteria || []).slice(0, 3).map((item) => (
                        <div key={`${row.id}-c-${item.code}`} className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 font-medium ${severityBadgeClass(item.severity)}`}>
                            {item.severity}
                          </span>
                          <span>{item.title}</span>
                        </div>
                      ))}
                      <div className="text-muted-foreground">
                        {(row.source_citations || []).length} citations / {(row.safety_flags || []).length} safety flags
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-xl space-y-1 text-xs">
                      {(row.bundle_gaps || []).slice(0, 4).map((gap) => (
                        <div key={`${row.id}-g-${gap.code}`} className="text-orange-800">{gap.title}</div>
                      ))}
                      {!row.bundle_gaps?.length ? (
                        <span className="text-muted-foreground">No bundle gaps in draft</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    {row.reviewer_decision === "pending" ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "acknowledged" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "escalated" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
                        >
                          Escalate
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "dismissed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Dismiss
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

// ---------------------------------------------------------------------------
// Consent & PHI Policy Sentinel
// ---------------------------------------------------------------------------
export function PrivacySentinelPanel() {
  const queryClient = useQueryClient();
  const [riskFilter, setRiskFilter] = useState<PrivacySentinelRiskBand | "">("");
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [moduleFilter, setModuleFilter] = useState("");
  const [windowDays, setWindowDays] = useState("7");

  const audits = useQuery({
    queryKey: ["clinical-ai", "privacy-sentinel", riskFilter, decisionFilter, moduleFilter],
    queryFn: () =>
      listPrivacySentinelAudits({
        riskBand: riskFilter || undefined,
        decision: decisionFilter || undefined,
        moduleKey: moduleFilter.trim() || undefined,
        limit: 100,
      }),
  });
  const scan = useMutation({
    mutationFn: () =>
      runPrivacySentinelScan({
        windowDays: Number.parseInt(windowDays.trim(), 10) || 7,
        limit: 100,
      }),
    onSuccess: (result) => {
      toast.success(`Privacy scan complete: ${result.summary.findings} finding(s)`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "privacy-sentinel"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Privacy scan failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "acknowledged" | "escalated" | "dismissed" }) =>
      decidePrivacySentinelAudit(id, decision),
    onSuccess: () => {
      toast.success("Privacy sentinel review saved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "privacy-sentinel"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "audit"] });
    },
    onError: (err: Error) => toast.error(err.message || "Review failed"),
  });

  const rows: PrivacySentinelAudit[] = audits.data?.audits ?? [];
  const criticalCount = rows.filter((row) => row.risk_band === "critical").length;
  const externalCount = rows.filter((row) => Boolean(row.metadata?.external_provider)).length;
  const pendingCount = rows.filter((row) => row.reviewer_decision === "pending").length;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Consent & PHI Policy Sentinel</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={moduleFilter}
            onChange={(event) => setModuleFilter(event.target.value)}
            placeholder="module key"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <select
            value={riskFilter}
            onChange={(event) => setRiskFilter(event.target.value as PrivacySentinelRiskBand | "")}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="">All risk</option>
            {PRIVACY_RISK_BANDS.map((risk) => (
              <option key={risk} value={risk}>{risk}</option>
            ))}
          </select>
          <select
            value={decisionFilter}
            onChange={(event) => setDecisionFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="pending">Pending</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="escalated">Escalated</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All decisions</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Critical</div>
          <div className="mt-1 text-2xl font-semibold text-red-700">{criticalCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">External provider</div>
          <div className="mt-1 text-2xl font-semibold">{externalCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Pending review</div>
          <div className="mt-1 text-2xl font-semibold">{pendingCount}</div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Scan window (days)</span>
            <input
              value={windowDays}
              onChange={(event) => setWindowDays(event.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {scan.isPending ? "Scanning..." : "Run Scan"}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Generation</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Risk</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Consent</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Review</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No privacy sentinel audits found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">gen #{row.generation_id || "-"}</div>
                    <div className="font-medium">{row.module_key || "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.provider || "template"} / {fmt(row.generation_created_at || row.created_at)}</div>
                    {row.patient_name ? <div className="text-xs text-muted-foreground">{row.patient_name}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-lg font-semibold">{row.risk_score}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(row.risk_band)}`}>
                      {row.risk_band}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-xl flex-wrap gap-1">
                      {row.findings.slice(0, 4).map((finding) => (
                        <span key={finding.code} className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(finding.severity)}`}>
                          {finding.code}
                        </span>
                      ))}
                      {row.findings.length === 0 ? <span className="text-xs text-muted-foreground">none</span> : null}
                    </div>
                    {row.findings[0]?.recommendation ? (
                      <div className="mt-1 max-w-xl text-xs text-muted-foreground">{row.findings[0].recommendation}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs">
                      {row.consent_snapshot?.active_count ?? 0} active
                    </div>
                    <div className="mt-1 flex max-w-sm flex-wrap gap-1">
                      {(row.consent_snapshot?.active_types || []).slice(0, 3).map((type) => (
                        <span key={type} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
                          {type}
                        </span>
                      ))}
                      {(row.consent_snapshot?.active_types || []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">none</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${documentStatusClass(row.reviewer_decision)}`}>
                      {row.reviewer_decision}
                    </span>
                    <div className="mt-1 text-xs text-muted-foreground">{fmt(row.created_at)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "acknowledged" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "escalated" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Escalate
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "dismissed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{fmt(row.reviewed_at)}</span>
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

// ---------------------------------------------------------------------------
// Prompt A/B Experiments
// ---------------------------------------------------------------------------
export function PromptExperimentsPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("running");
  const experiments = useQuery({
    queryKey: ["clinical-ai", "experiments", statusFilter],
    queryFn: () => listPromptExperiments(statusFilter || undefined),
  });
  const conclude = useMutation({
    mutationFn: ({ id, winner }: { id: number; winner?: "A" | "B" }) =>
      concludePromptExperiment(id, winner),
    onSuccess: () => {
      toast.success("Experiment concluded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "experiments"] });
    },
    onError: (err: Error) => toast.error(err.message || "Conclude failed"),
  });
  const rows: PromptExperiment[] = experiments.data?.experiments ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Prompt Experiments (A/B)</h2>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="running">Running</option>
          <option value="concluded">Concluded</option>
          <option value="paused">Paused</option>
          <option value="draft">Draft</option>
          <option value="">All</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Traffic-split between two candidate prompts per module. Winner hint fires at +10pp acceptance with &ge;20 samples each arm.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Module</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Split</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Started</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No experiments in this bucket
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.module_key}</td>
                  <td className="px-4 py-3">{row.name}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {Math.round(Number(row.traffic_split_a) * 100)}% / {100 - Math.round(Number(row.traffic_split_a) * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.status === "running" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {row.status}
                    </span>
                    {row.winning_variant ? (
                      <span className="ml-2 text-xs text-muted-foreground">winner: {row.winning_variant}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.started_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.status === "running" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => conclude.mutate({ id: row.id, winner: "A" })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ship A
                        </button>
                        <button
                          onClick={() => conclude.mutate({ id: row.id, winner: "B" })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ship B
                        </button>
                        <button
                          onClick={() => conclude.mutate({ id: row.id })}
                          disabled={conclude.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Conclude
                        </button>
                      </div>
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// Drift Canary
// ---------------------------------------------------------------------------
export function DriftCanaryPanel() {
  const queryClient = useQueryClient();
  const [caseModuleKey, setCaseModuleKey] = useState("discharge_summary");
  const [caseLabel, setCaseLabel] = useState("");
  const [expectedKeys, setExpectedKeys] = useState("hospital_course, discharge_diagnosis");
  const [expectedCitationsMin, setExpectedCitationsMin] = useState("1");
  const [inputPacket, setInputPacket] = useState(() => DEFAULT_CANARY_INPUT_PACKET);
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

// ---------------------------------------------------------------------------
// Capacity Forecasts
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Operational Predictions
// ---------------------------------------------------------------------------
export function OperationalPredictionPanel() {
  const [appointmentId, setAppointmentId] = useState("");
  const [otScheduleId, setOtScheduleId] = useState("");
  const [noShowResult, setNoShowResult] = useState<NoShowRiskPrediction | null>(null);
  const [otResult, setOtResult] = useState<OtCaseTimePrediction | null>(null);

  const noShow = useMutation({
    mutationFn: () => scoreNoShowRisk(Number.parseInt(appointmentId.trim(), 10)),
    onSuccess: (result) => {
      setNoShowResult(result);
      toast.success(`No-show risk: ${result.band}`);
    },
    onError: (err: Error) => toast.error(err.message || "No-show scoring failed"),
  });
  const ot = useMutation({
    mutationFn: () => predictOtCaseTime(Number.parseInt(otScheduleId.trim(), 10)),
    onSuccess: (result) => {
      setOtResult(result);
      toast.success(`OT estimate: ${result.predicted_minutes} min`);
    },
    onError: (err: Error) => toast.error(err.message || "OT prediction failed"),
  });

  const canScoreAppointment = Number.isFinite(Number.parseInt(appointmentId.trim(), 10));
  const canScoreOt = Number.isFinite(Number.parseInt(otScheduleId.trim(), 10));

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Operational Predictions</h2>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Appointment ID</span>
              <input
                value={appointmentId}
                onChange={(event) => setAppointmentId(event.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <button
              onClick={() => noShow.mutate()}
              disabled={noShow.isPending || !canScoreAppointment}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {noShow.isPending ? "Scoring..." : "Score No-Show"}
            </button>
          </div>
          {noShowResult ? (
            <div className="mt-4 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-muted-foreground">Risk score</div>
                  <div className="text-2xl font-semibold">{noShowResult.risk_score}</div>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chartRiskClass(noShowResult.band)}`}>
                  {noShowResult.band}
                </span>
              </div>
              <div className="mt-2 text-sm">{noShowResult.recommended_action}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                {Object.entries(noShowResult.contributors || {}).slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`).join(" / ") || "No contributors returned"}
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">OT schedule ID</span>
              <input
                value={otScheduleId}
                onChange={(event) => setOtScheduleId(event.target.value)}
                inputMode="numeric"
                className="w-full rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <button
              onClick={() => ot.mutate()}
              disabled={ot.isPending || !canScoreOt}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {ot.isPending ? "Predicting..." : "Predict OT Time"}
            </button>
          </div>
          {otResult ? (
            <div className="mt-4 rounded-lg border border-border bg-background p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <div className="text-sm text-muted-foreground">Predicted</div>
                  <div className="text-2xl font-semibold">{otResult.predicted_minutes}m</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Confidence</div>
                  <div className="text-2xl font-semibold">{otResult.confidence_pct}%</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Sample</div>
                  <div className="text-2xl font-semibold">{otResult.sample_size}</div>
                </div>
              </div>
              <div className="mt-2 text-sm">{otResult.procedure_name || "Procedure not named"}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                {Object.entries(otResult.contributors || {}).slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`).join(" / ") || "No contributors returned"}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Charge Capture Audits
// ---------------------------------------------------------------------------
export function ChargeCapturePanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const audits = useQuery({
    queryKey: ["clinical-ai", "charge-capture", decisionFilter],
    queryFn: () => listChargeCaptureAudits(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "captured" | "rejected" }) =>
      decideChargeCaptureAudit(id, decision),
    onSuccess: () => {
      toast.success("Audit decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "charge-capture"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: ChargeCaptureAudit[] = audits.data?.audits ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Charge Capture Audits</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="captured">Captured</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Missed codes</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Est revenue</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scanned</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No audits
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">#{row.admission_id}</td>
                  <td className="px-4 py-3">
                    {row.missed_codes.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {row.missed_codes.slice(0, 4).map((c, idx) => (
                          <li key={idx}><span className="font-mono">{c.code}</span> — {c.description}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">{fmtMoneyMinor(row.estimated_revenue_minor)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scanned_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "captured" })}
                          disabled={decide.isPending || row.missed_codes.length === 0}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Capture
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.reviewer_decision}</span>
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

// ---------------------------------------------------------------------------
// Deterioration Early Warning
// ---------------------------------------------------------------------------
function deteriorationBandClass(band: string) {
  if (band === "critical") return "bg-red-200 text-red-900 border-red-300";
  if (band === "concerning") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function DeteriorationPanel() {
  const [bandFilter, setBandFilter] = useState<DeteriorationBand | "">("concerning");
  const snapshots = useQuery({
    queryKey: ["clinical-ai", "deterioration", bandFilter],
    queryFn: () => listDeteriorationSnapshots(bandFilter || undefined),
  });
  const rows: DeteriorationSnapshot[] = snapshots.data?.snapshots ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Deterioration Early Warning</h2>
        </div>
        <select
          value={bandFilter}
          onChange={(event) => setBandFilter(event.target.value as DeteriorationBand | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="critical">Critical only</option>
          <option value="concerning">Concerning + critical</option>
          <option value="watch">Watch</option>
          <option value="stable">Stable</option>
          <option value="">All bands</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Composite score (NEWS2 + trend + lab). Decision support; never silences a rule-based alarm.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Band</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Score</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Components</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Top rec</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No snapshots in this band
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const topRec = row.recommendations?.[0];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-xs">{row.patient_uid}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${deteriorationBandClass(row.band)}`}>
                        {row.band}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold">{Number(row.score).toFixed(0)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      news {Number(row.news2_component).toFixed(0)} · trend {Number(row.trend_component).toFixed(0)} · lab {Number(row.lab_component).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-xs">{topRec?.message ?? "-"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Polypharmacy Reviews
// ---------------------------------------------------------------------------
export function PolypharmacyPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const reviews = useQuery({
    queryKey: ["clinical-ai", "polypharmacy", decisionFilter],
    queryFn: () => listPolypharmacyReviews(decisionFilter || undefined),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "acknowledged" | "overridden" | "prescription_changed"; note?: string }) =>
      decidePolypharmacyReview(id, decision, note),
    onSuccess: () => {
      toast.success("Review decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "polypharmacy"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: PolypharmacyReview[] = reviews.data?.reviews ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Polypharmacy Reviews</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="overridden">Overridden</option>
          <option value="prescription_changed">Prescription changed</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Rule findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">AI findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scored</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No reviews
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-xs">{row.patient_uid}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.combined_severity)}`}>
                      {row.combined_severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{row.rule_findings.length} finding(s)</div>
                    {row.rule_findings[0] ? (
                      <div className="text-xs">{row.rule_findings[0].code}: {row.rule_findings[0].message.slice(0, 80)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{row.ai_findings.length} finding(s)</div>
                    {row.ai_findings[0] ? (
                      <div className="text-xs">{row.ai_findings[0].code}: {row.ai_findings[0].message.slice(0, 80)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "acknowledged" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Ack
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "prescription_changed" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Rx changed
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Override reason (clinical justification)") ?? undefined;
                            decide.mutate({ id: row.id, decision: "overridden", note });
                          }}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Override
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.reviewer_decision}</span>
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

// ---------------------------------------------------------------------------
// Clinical Trial Catalog Sync (ClinicalTrials.gov v2)
// ---------------------------------------------------------------------------
export function TrialCatalogSyncPanel() {
  const queryClient = useQueryClient();
  const [conditions, setConditions] = useState("");
  const [location, setLocation] = useState("");
  const runs = useQuery({
    queryKey: ["clinical-ai", "trial-sync-runs"],
    queryFn: () => listTrialSyncRuns(),
  });
  const sync = useMutation({
    mutationFn: () => {
      const conditionList = conditions
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      return triggerTrialCatalogSync({
        conditions: conditionList.length ? conditionList : undefined,
        location: location.trim() || undefined,
        max_results: 100,
      });
    },
    onSuccess: (result) => {
      if (result.status === "failed") {
        toast.error(`Sync failed: ${result.error_message ?? "unknown error"}`);
      } else {
        toast.success(`Synced ${result.upserted_count} of ${result.fetched_count} trials`);
      }
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trial-sync-runs"] });
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trials"] });
    },
    onError: (err: Error) => toast.error(err.message || "Sync failed"),
  });
  const rows: TrialSyncRun[] = runs.data?.runs ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CloudDownload className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Trial Catalog Sync</h2>
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <CloudDownload className="h-4 w-4" />
          {sync.isPending ? "Syncing…" : "Sync ClinicalTrials.gov"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Pulls recruiting trials from the public registry. Blank conditions + location auto-seed from the tenant&apos;s most-common active diagnoses (India default for DPDP tenants).
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Conditions (comma-separated, optional)
          <input
            value={conditions}
            onChange={(event) => setConditions(event.target.value)}
            placeholder="diabetes mellitus, pneumonia"
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Location (country or city, optional)
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="India"
            className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Conditions</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Location</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Fetched</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Upserted</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={7}>
                  No sync history yet — run the first sync to populate.
                </td>
              </tr>
            ) : (
              rows.slice(0, 10).map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.source}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.query_conditions.slice(0, 3).join(", ")}
                    {row.query_conditions.length > 3 ? ` +${row.query_conditions.length - 3}` : ""}
                  </td>
                  <td className="px-4 py-3 text-xs">{row.query_location ?? "-"}</td>
                  <td className="px-4 py-3">{row.fetched_count}</td>
                  <td className="px-4 py-3">{row.upserted_count}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.status === "completed" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : row.status === "failed" ? "bg-red-100 text-red-800 border-red-200" : "bg-slate-100 text-slate-700 border-slate-200"}`}>
                      {row.status}
                    </span>
                    {row.error_message ? (
                      <div className="mt-1 text-xs text-red-700">{row.error_message.slice(0, 120)}</div>
                    ) : null}
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

// ---------------------------------------------------------------------------
// Clinical Trial Matches
// ---------------------------------------------------------------------------
export function TrialMatchesPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [patientUid, setPatientUid] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [minScore, setMinScore] = useState("30");
  const [matchLimit, setMatchLimit] = useState("10");
  const matches = useQuery({
    queryKey: ["clinical-ai", "trials", decisionFilter],
    queryFn: () => listTrialMatches(decisionFilter || undefined),
  });
  const runMatch = useMutation({
    mutationFn: () => {
      const admission = admissionId.trim();
      const score = Math.min(Math.max(Number.parseInt(minScore, 10) || 30, 0), 100);
      const limit = Math.min(Math.max(Number.parseInt(matchLimit, 10) || 10, 1), 50);
      return matchPatientAgainstTrials(patientUid.trim(), {
        min_score: score,
        limit,
        ...(admission ? { admission_id: admission } : {}),
      });
    },
    onSuccess: (result) => {
      const message = result.note
        ? `Trial match skipped: ${result.note}`
        : `Trial match complete: ${result.persisted_count} saved`;
      toast(message);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trials"] });
    },
    onError: (err: Error) => toast.error(err.message || "Trial match failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "offered" | "enrolled" | "declined" | "ineligible" }) =>
      decideTrialMatch(id, decision),
    onSuccess: () => {
      toast.success("Match decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "trials"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: TrialMatch[] = matches.data?.matches ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Microscope className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Clinical Trial Matches</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="offered">Offered</option>
          <option value="enrolled">Enrolled</option>
          <option value="declined">Declined</option>
          <option value="ineligible">Ineligible</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.6fr)_120px_120px_auto] md:items-end">
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
            <span className="text-muted-foreground">Min score</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={(event) => setMinScore(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Limit</span>
            <input
              type="number"
              min={1}
              max={50}
              value={matchLimit}
              onChange={(event) => setMatchLimit(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => runMatch.mutate()}
            disabled={!patientUid.trim() || runMatch.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            <FileSearch className="h-4 w-4" />
            Match
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Trial</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Match</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Scored</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No trial matches awaiting this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.title}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.nct_id}{row.phase ? ` · ${row.phase}` : ""}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold">{Number(row.match_score).toFixed(0)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.scored_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.coordinator_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "offered" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Offer
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "ineligible" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Ineligible
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.coordinator_decision}</span>
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

// ---------------------------------------------------------------------------
// RCA Drafts
// ---------------------------------------------------------------------------
export function RcaDraftsPanel() {
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState("pending");
  const [admissionId, setAdmissionId] = useState("");
  const [caseType, setCaseType] = useState<RcaCaseType>("mortality");
  const drafts = useQuery({
    queryKey: ["clinical-ai", "rca", decisionFilter],
    queryFn: () => listRcaDrafts(decisionFilter || undefined),
  });
  const generate = useMutation({
    mutationFn: () => generateRcaDraft(admissionId.trim(), caseType),
    onSuccess: (result) => {
      toast.success(`RCA draft generated: ${result.case_type}`);
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "rca"] });
    },
    onError: (err: Error) => toast.error(err.message || "RCA generation failed"),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: number; decision: "accepted" | "revised" | "rejected"; note?: string }) =>
      decideRcaDraft(id, decision, note),
    onSuccess: () => {
      toast.success("RCA decided");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "rca"] });
    },
    onError: (err: Error) => toast.error(err.message || "Decision failed"),
  });
  const rows: RcaDraftSummary[] = drafts.data?.drafts ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Mortality / RCA Drafts</h2>
        </div>
        <select
          value={decisionFilter}
          onChange={(event) => setDecisionFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="revised">Revised</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Admission ID</span>
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              placeholder="admission id"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Case type</span>
            <select
              value={caseType}
              onChange={(event) => setCaseType(event.target.value as RcaCaseType)}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="mortality">Mortality</option>
              <option value="readmission">Readmission</option>
              <option value="infection">Infection</option>
              <option value="never_event">Never event</option>
              <option value="complaint">Complaint</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={!admissionId.trim() || generate.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            Generate
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Case type</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Admission</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Decision</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                  No RCA drafts awaiting this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs">{row.case_type}</td>
                  <td className="px-4 py-3 font-mono text-xs">#{row.admission_id}</td>
                  <td className="px-4 py-3 text-xs">{row.reviewer_decision}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {row.reviewer_decision === "pending" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => decide.mutate({ id: row.id, decision: "accepted" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Accept
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
                          onClick={() => decide.mutate({ id: row.id, decision: "rejected" })}
                          disabled={decide.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
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
    </section>
  );
}

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

export function PriorAuthorizationPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("draft");
  const [admissionId, setAdmissionId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [procedureCode, setProcedureCode] = useState("");
  const [procedureDescription, setProcedureDescription] = useState("");
  const [requestedServiceType, setRequestedServiceType] = useState("inpatient_procedure");
  const canGenerate = Boolean(admissionId.trim() && payerName.trim() && procedureCode.trim());
  const auths = useQuery({
    queryKey: ["clinical-ai", "prior-auth", statusFilter],
    queryFn: () => listPriorAuthorizations(statusFilter || undefined),
  });
  const generate = useMutation({
    mutationFn: () =>
      generatePriorAuthorization({
        admission_id: admissionId.trim(),
        payer_name: payerName.trim(),
        procedure_code: procedureCode.trim(),
        requested_service_type: requestedServiceType,
        ...(policyNumber.trim() ? { policy_number: policyNumber.trim() } : {}),
        ...(procedureDescription.trim() ? { procedure_description: procedureDescription.trim() } : {}),
      }),
    onSuccess: (result) => {
      toast.success(`Prior auth draft ${result.prior_auth_id ? `#${result.prior_auth_id}` : ""} generated`);
      setStatusFilter("draft");
      setProcedureCode("");
      setProcedureDescription("");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prior-auth"] });
    },
    onError: (err: Error) => toast.error(err.message || "Generation failed"),
  });
  const submit = useMutation({
    mutationFn: ({ id, payerReferenceId }: { id: number; payerReferenceId?: string }) =>
      submitPriorAuthorization(id, payerReferenceId),
    onSuccess: () => {
      toast.success("Prior auth submitted to payer");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prior-auth"] });
    },
    onError: (err: Error) => toast.error(err.message || "Submit failed"),
  });
  const payerDecision = useMutation({
    mutationFn: ({ id, decision, reason }: { id: number; decision: "approved" | "denied" | "withdrawn"; reason?: string }) =>
      recordPriorAuthPayerDecision(id, decision, reason),
    onSuccess: () => {
      toast.success("Payer decision recorded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "prior-auth"] });
    },
    onError: (err: Error) => toast.error(err.message || "Record failed"),
  });
  const rows: PriorAuthRequest[] = auths.data?.prior_auths ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Prior Authorization</h2>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="denied">Denied</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="">All</option>
        </select>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canGenerate) generate.mutate();
        }}
        className="rounded-lg border border-border bg-card/60 p-3"
      >
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Generate Packet</h3>
            <p className="text-xs text-muted-foreground">Creates a review-only payer packet from the admission chart.</p>
          </div>
          <button
            type="submit"
            disabled={!canGenerate || generate.isPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <FileSearch className="h-4 w-4" />
            {generate.isPending ? "Generating..." : "Generate"}
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-muted-foreground">
            Admission ID
            <input
              value={admissionId}
              onChange={(event) => setAdmissionId(event.target.value)}
              placeholder="123"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Payer
            <input
              value={payerName}
              onChange={(event) => setPayerName(event.target.value)}
              placeholder="Insurance or TPA"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Policy number
            <input
              value={policyNumber}
              onChange={(event) => setPolicyNumber(event.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Procedure code
            <input
              value={procedureCode}
              onChange={(event) => setProcedureCode(event.target.value)}
              placeholder="CPT / internal code"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground md:col-span-2">
            Procedure description
            <input
              value={procedureDescription}
              onChange={(event) => setProcedureDescription(event.target.value)}
              placeholder="Procedure or treatment requested"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Service type
            <select
              value={requestedServiceType}
              onChange={(event) => setRequestedServiceType(event.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="inpatient_procedure">Inpatient procedure</option>
              <option value="planned_admission">Planned admission</option>
              <option value="diagnostic_imaging">Diagnostic imaging</option>
              <option value="medication">Medication</option>
              <option value="therapy">Therapy</option>
            </select>
          </label>
        </div>
      </form>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Payer</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Procedure</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Submitted</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Payer decision</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No prior-auth requests
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.payer_name}</div>
                    <div className="text-xs text-muted-foreground">{row.policy_number ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">{row.procedure_code}</div>
                    <div className="text-xs text-muted-foreground">{row.procedure_description ?? "-"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${priorAuthStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <div>{fmt(row.submitted_at)}</div>
                    {row.payer_reference_id ? (
                      <div className="font-mono text-[11px] text-foreground">Ref {row.payer_reference_id}</div>
                    ) : null}
                    {priorAuthSubmissionLabel(row) ? (
                      <div>{priorAuthSubmissionLabel(row)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.payer_decided_at ? (
                      <>
                        {fmt(row.payer_decided_at)}
                        {row.payer_decision_reason ? <div>{row.payer_decision_reason}</div> : null}
                      </>
                    ) : "-"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.status === "draft" ? (
                      <button
                        onClick={() => {
                          const reference = window.prompt("Payer reference ID (optional)");
                          if (reference === null) return;
                          submit.mutate({ id: row.id, payerReferenceId: reference.trim() || undefined });
                        }}
                        disabled={submit.isPending}
                        className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        Submit
                      </button>
                    ) : row.status === "submitted" ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => payerDecision.mutate({ id: row.id, decision: "approved" })}
                          disabled={payerDecision.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Approved
                        </button>
                        <button
                          onClick={() => {
                            const reason = window.prompt("Denial reason") ?? undefined;
                            payerDecision.mutate({ id: row.id, decision: "denied", reason });
                          }}
                          disabled={payerDecision.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Denied
                        </button>
                      </div>
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
    </section>
  );
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

// ---------------------------------------------------------------------------
// Virtual ward
// ---------------------------------------------------------------------------
function virtualWardSeverityClass(severity: string) {
  if (severity === "red") return "bg-red-200 text-red-900 border-red-300";
  if (severity === "amber") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function VirtualWardPanel() {
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<VirtualWardSeverity | "">("red");
  const escalations = useQuery({
    queryKey: ["clinical-ai", "virtual-ward", severityFilter],
    queryFn: () => listVirtualWardEscalations(severityFilter || undefined),
    refetchInterval: 60_000,
  });
  const enrollments = useQuery({
    queryKey: ["clinical-ai", "virtual-ward", "enrollments"],
    queryFn: () => listVirtualWardEnrollments(),
  });
  const ack = useMutation({
    mutationFn: (id: number) => acknowledgeVirtualWardEscalation(id),
    onSuccess: () => {
      toast.success("Escalation acknowledged");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "virtual-ward"] });
    },
    onError: (err: Error) => toast.error(err.message || "Acknowledge failed"),
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolution, note }: { id: number; resolution: string; note?: string }) =>
      resolveVirtualWardEscalation(id, resolution, note),
    onSuccess: () => {
      toast.success("Escalation resolved");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "virtual-ward"] });
    },
    onError: (err: Error) => toast.error(err.message || "Resolve failed"),
  });
  const escRows: VirtualWardEscalation[] = escalations.data?.escalations ?? [];
  const enrollRows: VirtualWardEnrollment[] = enrollments.data?.enrollments ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Heart className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Virtual Ward — Open Escalations</h2>
        </div>
        <select
          value={severityFilter}
          onChange={(event) => setSeverityFilter(event.target.value as VirtualWardSeverity | "")}
          className="rounded-md border border-border bg-card px-2 py-1 text-sm"
        >
          <option value="red">Red only</option>
          <option value="amber">Amber only</option>
          <option value="">All open</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Post-discharge check-ins triaged green/amber/red. Red submissions mark the enrollment as escalated. Care manager acknowledges + resolves.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Active enrollments</div>
          <div className="mt-1 text-2xl font-semibold">{enrollRows.filter((e) => e.status === "active").length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Escalated enrollments</div>
          <div className="mt-1 text-2xl font-semibold text-red-700">{enrollRows.filter((e) => e.status === "escalated").length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Open escalations</div>
          <div className="mt-1 text-2xl font-semibold">{escRows.length}</div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Pathway</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {escRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No open escalations in this bucket
                </td>
              </tr>
            ) : (
              escRows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${virtualWardSeverityClass(row.severity)}`}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.patient_name ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.patient_uid}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.pathway ?? "-"}</td>
                  <td className="px-4 py-3 max-w-md text-xs">{row.reason}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {!row.acknowledged_at ? (
                      <button
                        onClick={() => ack.mutate(row.id)}
                        disabled={ack.isPending}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    ) : !row.resolved_at ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => resolve.mutate({ id: row.id, resolution: "call_completed" })}
                          disabled={resolve.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Call done
                        </button>
                        <button
                          onClick={() => resolve.mutate({ id: row.id, resolution: "referred_to_ed" })}
                          disabled={resolve.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Refer ED
                        </button>
                        <button
                          onClick={() => {
                            const note = window.prompt("Resolution note (optional)") ?? undefined;
                            resolve.mutate({ id: row.id, resolution: "resolved_remotely", note });
                          }}
                          disabled={resolve.isPending}
                          className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          Resolved
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.resolution}</span>
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

// ---------------------------------------------------------------------------
// Ambient clinical documentation
// ---------------------------------------------------------------------------
export function AmbientDocumentationPanel() {
  const [patientFilter, setPatientFilter] = useState("");
  const [appliedPatientUid, setAppliedPatientUid] = useState("");
  const encounters = useQuery({
    queryKey: ["clinical-ai", "ambient", appliedPatientUid],
    queryFn: () =>
      listAmbientEncounters({
        patientUid: appliedPatientUid || undefined,
        limit: 50,
      }),
    refetchInterval: 60_000,
  });
  const rows: AmbientEncounter[] = encounters.data?.encounters ?? [];
  const completed = rows.filter((row) => row.transcript_status === "completed").length;
  const totalDuration = rows.reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0);
  const avgSpeakers = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + Number(row.speaker_count || 0), 0) / rows.length)
    : 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Mic2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Ambient Documentation</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={patientFilter}
            onChange={(event) => setPatientFilter(event.target.value)}
            placeholder="patient uid"
            className="min-w-72 rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <button
            onClick={() => setAppliedPatientUid(patientFilter.trim())}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Filter
          </button>
          <button
            onClick={() => {
              setPatientFilter("");
              setAppliedPatientUid("");
            }}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ClipboardCheck className="h-4 w-4" />
            Completed transcripts
          </div>
          <div className="mt-1 text-2xl font-semibold">{completed}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <UsersRound className="h-4 w-4" />
            Avg speakers
          </div>
          <div className="mt-1 text-2xl font-semibold">{avgSpeakers}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock3 className="h-4 w-4" />
            Audio reviewed
          </div>
          <div className="mt-1 text-2xl font-semibold">{fmtDuration(totalDuration)}</div>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Patient</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Recording</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">STT</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Speakers</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Generation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No ambient encounters found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${row.transcript_status === "completed" ? "bg-emerald-100 text-emerald-800 border-emerald-200" : "bg-amber-100 text-amber-800 border-amber-200"}`}>
                      {row.transcript_status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">{row.patient_uid}</div>
                    {row.admission_id ? (
                      <div className="text-xs text-muted-foreground">admission #{row.admission_id}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div>{fmt(row.recording_started_at)}</div>
                    <div className="text-xs text-muted-foreground">{fmtDuration(row.duration_seconds)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{row.stt_provider || "-"}</div>
                    <div className="text-xs text-muted-foreground">{row.diarization_provider || "no diarization provider"}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold">{row.speaker_count}</td>
                  <td className="px-4 py-3">
                    {row.generation_id ? (
                      <span className="font-mono text-xs">#{row.generation_id}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">not saved</span>
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

export function RosterOptimizerPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("suggested");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [department, setDepartment] = useState("NURSING");
  const [startDate, setStartDate] = useState(() => defaultDate(1));
  const [endDate, setEndDate] = useState(() => defaultDate(7));
  const [latestSuggestion, setLatestSuggestion] = useState<RosterSuggestion | null>(null);
  const runs = useQuery({
    queryKey: ["clinical-ai", "roster", departmentFilter, statusFilter],
    queryFn: () =>
      listRosterRuns({
        department: departmentFilter || undefined,
        status: statusFilter || undefined,
        limit: 50,
      }),
  });
  const generate = useMutation({
    mutationFn: () =>
      generateRosterSuggestion({
        department: department.trim(),
        start_date: startDate,
        end_date: endDate,
      }),
    onSuccess: (result) => {
      setLatestSuggestion(result);
      toast.success("Roster suggestion generated");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "roster"] });
    },
    onError: (err: Error) => toast.error(err.message || "Roster generation failed"),
  });
  const publish = useMutation({
    mutationFn: (id: number) => publishRosterRun(id),
    onSuccess: () => {
      toast.success("Roster published");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "roster"] });
    },
    onError: (err: Error) => toast.error(err.message || "Publish failed"),
  });
  const discard = useMutation({
    mutationFn: (id: number) => discardRosterRun(id),
    onSuccess: () => {
      toast.success("Roster discarded");
      queryClient.invalidateQueries({ queryKey: ["clinical-ai", "roster"] });
    },
    onError: (err: Error) => toast.error(err.message || "Discard failed"),
  });
  const rows: RosterRun[] = runs.data?.runs ?? [];
  const openRuns = rows.filter((row) => ["suggested", "edited"].includes(row.status));
  const totalGaps = rows.reduce((sum, row) => sum + Number(row.coverage_gap_count || 0), 0);
  const totalConflicts = rows.reduce((sum, row) => sum + Number(row.preference_conflict_count || 0), 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Staff Roster Optimizer</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
            placeholder="department filter"
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 text-sm"
          >
            <option value="suggested">Suggested</option>
            <option value="edited">Edited</option>
            <option value="published">Published</option>
            <option value="discarded">Discarded</option>
            <option value="">All</option>
          </select>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Open runs</div>
          <div className="mt-1 text-2xl font-semibold">{openRuns.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Coverage gaps</div>
          <div className="mt-1 text-2xl font-semibold text-amber-700">{totalGaps}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">Preference conflicts</div>
          <div className="mt-1 text-2xl font-semibold">{totalConflicts}</div>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Department</span>
            <input
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Start</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">End</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <div className="flex items-end">
            <button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !department.trim() || !startDate || !endDate}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              <PlayCircle className="h-4 w-4" />
              {generate.isPending ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      </div>
      {latestSuggestion ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">{latestSuggestion.department} suggestion</div>
              <div className="text-xs text-muted-foreground">
                {latestSuggestion.filled_slots} / {latestSuggestion.total_slots} slots · {latestSuggestion.staff_pool_size} staff
              </div>
            </div>
            {latestSuggestion.run_id ? (
              <div className="inline-flex gap-1">
                <button
                  onClick={() => publish.mutate(Number(latestSuggestion.run_id))}
                  disabled={publish.isPending}
                  className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  Publish
                </button>
                <button
                  onClick={() => discard.mutate(Number(latestSuggestion.run_id))}
                  disabled={discard.isPending}
                  className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                >
                  Discard
                </button>
              </div>
            ) : null}
          </div>
          <RosterFindingsList
            gaps={latestSuggestion.coverage_gaps}
            conflicts={latestSuggestion.preference_conflicts}
          />
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Department</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Range</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Coverage</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Findings</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No roster runs found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.department}</div>
                    <div className="text-xs text-muted-foreground">{fmt(row.created_at)}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {String(row.start_date).slice(0, 10)} → {String(row.end_date).slice(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold">{row.filled_slots} / {row.total_slots}</div>
                    <div className="text-xs text-muted-foreground">filled slots</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.coverage_gap_count} gaps · {row.preference_conflict_count} conflicts
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${rosterStatusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {["suggested", "edited"].includes(row.status) ? (
                      <div className="inline-flex gap-1">
                        <button
                          onClick={() => publish.mutate(row.id)}
                          disabled={publish.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Publish
                        </button>
                        <button
                          onClick={() => discard.mutate(row.id)}
                          disabled={discard.isPending}
                          className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                        >
                          Discard
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{row.published_at ? fmt(row.published_at) : "-"}</span>
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

// Re-export a single header for the section in page.tsx.
export function AIExpansionHeader() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="h-4 w-4" />
        Clinical AI expansion — decision-support only
      </div>
      <p className="mt-1">
        The panels below surface AI-generated decisions for human review. Every action below records a tenant-scoped audit entry.
        These modules never auto-action — clinicians, coders, and coordinators decide.
      </p>
    </div>
  );
}

export { Activity }; // keep the icon export so page.tsx tree-shakes cleanly
