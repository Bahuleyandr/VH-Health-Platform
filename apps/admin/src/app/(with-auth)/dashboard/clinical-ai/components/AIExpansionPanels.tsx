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
  Microscope,
  Mic2,
  PlayCircle,
  Receipt,
  Stethoscope,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  acknowledgeVirtualWardEscalation,
  decideChartCompletionAudit,
  decideInfectionControlAudit,
  decidePrivacySentinelAudit,
  concludePromptExperiment,
  decideChargeCaptureAudit,
  decideDocumentIntake,
  decideImagingFinding,
  decidePolypharmacyReview,
  discardRosterRun,
  decideRcaDraft,
  decideTrialMatch,
  generateAbnormalResultTriage,
  generateChartCompletionAudit,
  generateInfectionControlAudit,
  generateRosterSuggestion,
  ingestDocumentIntake,
  listAbnormalResultTriages,
  listAmbientEncounters,
  listCanaryRuns,
  listChartCompletionAudits,
  listChargeCaptureAudits,
  listDeteriorationSnapshots,
  listDocumentIntakes,
  listImagingFindings,
  listInfectionControlAudits,
  listPolypharmacyReviews,
  listPrivacySentinelAudits,
  listPriorAuthorizations,
  listPromptExperiments,
  listRcaDrafts,
  listRosterRuns,
  listTrialMatches,
  listTrialSyncRuns,
  listVirtualWardEnrollments,
  listVirtualWardEscalations,
  publishRosterRun,
  recordPriorAuthPayerDecision,
  resolveVirtualWardEscalation,
  runCanary,
  runPrivacySentinelScan,
  submitPriorAuthorization,
  triggerTrialCatalogSync,
  type AbnormalResultTriageDraft,
  type AbnormalTriageBand,
  type AmbientEncounter,
  type CanaryRunSummary,
  type ChartCompletionAudit,
  type ChartGapRiskBand,
  type ChargeCaptureAudit,
  type DeteriorationBand,
  type DeteriorationSnapshot,
  type DocumentIntake,
  type ImagingFinding,
  type ImagingSeverity,
  type InfectionControlAudit,
  type InfectionControlRiskBand,
  type PolypharmacyReview,
  type PrivacySentinelAudit,
  type PrivacySentinelRiskBand,
  type PriorAuthRequest,
  type PromptExperiment,
  type RcaDraftSummary,
  type RosterCoverageGap,
  type RosterPreferenceConflict,
  type RosterRun,
  type RosterSuggestion,
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
const PRIVACY_RISK_BANDS: PrivacySentinelRiskBand[] = ["critical", "high", "medium", "low"];
const ABNORMAL_TRIAGE_BANDS: AbnormalTriageBand[] = ["critical", "urgent", "watch", "routine"];
const INFECTION_RISK_BANDS: InfectionControlRiskBand[] = ["critical", "high", "medium", "low"];

function chartRiskClass(risk: string) {
  if (risk === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (risk === "high") return "bg-orange-100 text-orange-800 border-orange-200";
  if (risk === "medium") return "bg-amber-100 text-amber-800 border-amber-200";
  if (risk === "low") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function triageBandClass(band: string) {
  if (band === "critical") return "bg-red-100 text-red-800 border-red-200";
  if (band === "urgent") return "bg-orange-100 text-orange-800 border-orange-200";
  if (band === "watch") return "bg-amber-100 text-amber-800 border-amber-200";
  if (band === "routine") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
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
  const runs = useQuery({
    queryKey: ["clinical-ai", "canary", "runs"],
    queryFn: () => listCanaryRuns(),
  });
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
          disabled={run.isPending}
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
                  No runs yet — configure canary cases via POST /admin/clinical-ai/canary/cases then run.
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
  const matches = useQuery({
    queryKey: ["clinical-ai", "trials", decisionFilter],
    queryFn: () => listTrialMatches(decisionFilter || undefined),
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
                  No matches. Upload trials to /admin/clinical-ai/trials/catalog then POST /trials/match/:patientUid.
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
  const drafts = useQuery({
    queryKey: ["clinical-ai", "rca", decisionFilter],
    queryFn: () => listRcaDrafts(decisionFilter || undefined),
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
                  No drafts. Trigger via POST /admin/clinical-ai/rca/:admissionId.
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

export function PriorAuthorizationPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("draft");
  const auths = useQuery({
    queryKey: ["clinical-ai", "prior-auth", statusFilter],
    queryFn: () => listPriorAuthorizations(statusFilter || undefined),
  });
  const submit = useMutation({
    mutationFn: (id: number) => submitPriorAuthorization(id),
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
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.submitted_at)}</td>
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
                        onClick={() => submit.mutate(row.id)}
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
  const findings = useQuery({
    queryKey: ["clinical-ai", "imaging", decisionFilter, severityFilter],
    queryFn: () =>
      listImagingFindings({
        decision: decisionFilter || undefined,
        severity: severityFilter || undefined,
      }),
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
      <p className="text-xs text-muted-foreground">
        External-model inference ingested via POST /admin/clinical-ai/imaging/inference. Critical findings sort to the top. Radiologist decision is authoritative.
      </p>
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
                  No imaging findings. Register studies via POST /imaging/studies then ingest inference via POST /imaging/inference.
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
