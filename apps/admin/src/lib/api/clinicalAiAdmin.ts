import { deleteJSON, fetchAdminAPI, getJSON } from "./core";

export interface ClinicalAiModule {
  module_key: string;
  display_name: string;
  description?: string | null;
  enabled: boolean;
  provider_override?: string | null;
  model_override?: string | null;
  external_allowed: boolean;
  max_tokens?: number | null;
  temperature?: number | null;
  settings?: Record<string, unknown>;
  updated_at?: string | null;
  tenant_id?: string | null;
  tenant_override_id?: number | null;
  tenant_override_source?: "global" | "tenant" | string | null;
  global_enabled?: boolean;
  global_provider_override?: string | null;
  global_model_override?: string | null;
  global_external_allowed?: boolean;
  tenant_overrides?: {
    enabled?: boolean | null;
    provider_override?: string | null;
    model_override?: string | null;
    external_allowed?: boolean | null;
    max_tokens?: number | null;
    temperature?: number | null;
    settings?: Record<string, unknown>;
    updated_by?: string | null;
    updated_at?: string | null;
  } | null;
}

export type ClinicalAiModulePatch = Partial<Omit<ClinicalAiModule, "enabled" | "external_allowed">> & {
  enabled?: boolean | null;
  external_allowed?: boolean | null;
};

export interface ClinicalAiGuardrails {
  id: number;
  enabled: boolean;
  external_ai_enabled: boolean;
  daily_token_limit?: number | null;
  daily_cost_limit_minor?: number | null;
  request_token_limit?: number | null;
  fallback_rate_alert_pct: number;
  max_fallbacks_per_day?: number | null;
  latency_alert_ms: number;
  updated_at?: string | null;
}

export interface ClinicalAiBudgetStatus {
  window_days: number;
  enabled: boolean;
  external_ai_enabled: boolean;
  token_budget: {
    used: number;
    limit?: number | null;
    remaining?: number | null;
    percent_used?: number | null;
    tripped: boolean;
  };
  cost_budget: {
    used: number;
    limit?: number | null;
    remaining?: number | null;
    percent_used?: number | null;
    tripped: boolean;
  };
  request_token_limit?: number | null;
  fallback_rate_pct: number;
  alerts: Array<{ severity: string; code: string; message: string }>;
  blocking_reasons: string[];
  tripped: boolean;
}

export interface ClinicalAiAdapterStatus {
  key: string;
  display_name: string;
  surface?: string | null;
  provider?: string | null;
  mode?: string | null;
  model?: string | null;
  configured: boolean;
  status: string;
  reason?: string | null;
  external_call?: boolean;
  endpoint_configured?: boolean | null;
  api_key_configured?: boolean | null;
  auth_configured?: boolean | null;
  tenant_region?: string | null;
  allowed_regions?: string[];
  timeout_ms?: number | null;
}

export interface ClinicalAiUsageSummary {
  window_days: number;
  overall: {
    generation_count: number;
    ai_generation_count: number;
    fallback_count?: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost_minor?: number | null;
    safety_flag_count?: number;
    avg_latency_ms?: number | null;
    last_generation_at?: string | null;
  };
  by_module: Array<{
    module_key: string;
    generation_count: number;
    ai_generation_count: number;
    fallback_count?: number;
    total_tokens: number;
    estimated_cost_minor?: number | null;
    avg_latency_ms?: number | null;
    review_count?: number;
    accepted_count?: number;
    rejected_count?: number;
    revision_count?: number;
    pending_count?: number;
    acceptance_rate_pct?: number | null;
    last_generation_at?: string | null;
  }>;
  by_provider: Array<{
    provider: string;
    generation_count: number;
    ai_generation_count: number;
    fallback_count?: number;
    total_tokens: number;
    estimated_cost_minor?: number | null;
    avg_latency_ms?: number | null;
    last_generation_at?: string | null;
  }>;
  recent_failures: Array<{
    id: number;
    module_key?: string | null;
    task_type: string;
    provider: string;
    created_at: string;
  }>;
}

export interface ClinicalAiConfig {
  moduleKey?: string | null;
  provider: string;
  model: string;
  enabled: boolean;
  baseUrlConfigured: boolean;
  apiKeyConfigured?: boolean;
  externalProvider?: boolean;
  externalAllowed?: boolean;
  readiness?: string | null;
  supportedProviders?: string[];
}

export interface ClinicalAiStatus {
  config: ClinicalAiConfig;
  providerHealth: {
    ok: boolean;
    status: string;
    reason?: string | null;
    latencyMs?: number | null;
    httpStatus?: number;
  };
  guardrails: ClinicalAiGuardrails;
  budget: ClinicalAiBudgetStatus;
  modules: ClinicalAiModule[];
  usage: ClinicalAiUsageSummary;
  adapters?: ClinicalAiAdapterStatus[];
}

export interface ClinicalAiGeneration {
  id: number;
  patient_uid?: string;
  patient_name?: string;
  admission_id?: number;
  task_type: string;
  module_key?: string | null;
  provider: string;
  model?: string;
  status: string;
  used_ai: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  estimated_cost_minor?: number | null;
  latency_ms?: number | null;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  created_at: string;
}

export interface ClinicalAiSafetyFlag {
  generation_id: number;
  patient_uid?: string;
  patient_name?: string;
  admission_id?: number;
  module_key?: string | null;
  severity: string;
  code: string;
  message: string;
  created_at: string;
}

export interface ClinicalAiSafetyReviewSummary {
  window_days: number;
  reason?: string | null;
  overall: {
    review_count: number;
    passed_count: number;
    needs_review_count: number;
    blocked_count: number;
    avg_citation_coverage_pct?: number | null;
    low_citation_count: number;
    finding_count: number;
    high_or_critical_finding_count: number;
    last_review_at?: string | null;
  };
  by_module: Array<{
    module_key: string;
    review_count: number;
    passed_count: number;
    needs_review_count: number;
    blocked_count: number;
    avg_citation_coverage_pct?: number | null;
    high_or_critical_finding_count: number;
    last_review_at?: string | null;
  }>;
  recent_findings: Array<{
    review_id: number;
    generation_id?: number | null;
    module_key: string;
    status: string;
    citation_coverage_pct: number;
    severity?: string | null;
    code?: string | null;
    message?: string | null;
    created_at: string;
  }>;
}

export interface ClinicalAiAuditLog {
  id: number;
  uid?: string | null;
  role?: string | null;
  action: string;
  resource?: string | null;
  resource_id?: string | null;
  metadata?: {
    changed_fields?: string[];
    tenant_id?: string | null;
    tenant_region?: string | null;
    actor?: {
      uid?: string | null;
      id?: string | number | null;
      role?: string | null;
      email?: string | null;
      phone?: string | null;
    };
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } | null;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: string;
}

export interface ClinicalAiGovernanceReport {
  window_days: number;
  runtime: {
    provider_health: ClinicalAiStatus["providerHealth"];
    adapters: ClinicalAiAdapterStatus[];
    guardrails: ClinicalAiGuardrails;
    budget: ClinicalAiBudgetStatus;
  };
  modules: {
    all: ClinicalAiModule[];
    enabled: string[];
    high_risk_enabled: string[];
    external_enabled: string[];
  };
  usage: ClinicalAiUsageSummary;
  audit: {
    summary: {
      total: number;
      latest_at?: string | null;
      by_action: Array<{ action: string; count: number }>;
      by_actor_role: Array<{ role: string; count: number }>;
    };
    recent: ClinicalAiAuditLog[];
  };
  [key: string]: unknown;
}

export async function getClinicalAiStatus(days = 7) {
  return getJSON<ClinicalAiStatus>("/admin/clinical-ai/status", { days });
}

export async function updateClinicalAiTenantModule(moduleKey: string, payload: ClinicalAiModulePatch) {
  return fetchAdminAPI<ClinicalAiModule>(`/admin/clinical-ai/tenant-modules/${encodeURIComponent(moduleKey)}`, {
    method: "PATCH",
    body: payload,
  });
}

export async function resetClinicalAiTenantModule(moduleKey: string) {
  return deleteJSON<ClinicalAiModule>(`/admin/clinical-ai/tenant-modules/${encodeURIComponent(moduleKey)}`);
}

export async function updateClinicalAiGuardrails(payload: Partial<ClinicalAiGuardrails>) {
  return fetchAdminAPI<{ guardrails: ClinicalAiGuardrails; budget: ClinicalAiBudgetStatus }>(
    "/admin/clinical-ai/guardrails",
    { method: "PATCH", body: payload },
  );
}

export async function getClinicalAiGenerations() {
  return getJSON<{ generations: ClinicalAiGeneration[]; count: number }>("/admin/clinical-ai/generations");
}

export async function getClinicalAiSafetyFlags() {
  return getJSON<{ flags: ClinicalAiSafetyFlag[]; count: number }>("/admin/clinical-ai/safety-flags");
}

export async function getClinicalAiSafetyReviewSummary(days = 7) {
  return getJSON<ClinicalAiSafetyReviewSummary>("/admin/clinical-ai/safety-reviews/summary", { days });
}

export async function getClinicalAiAuditLogs(limit = 50) {
  return getJSON<{ logs: ClinicalAiAuditLog[]; count: number }>("/admin/clinical-ai/audit", { limit });
}

export async function getClinicalAiGovernanceReport(days = 30) {
  return getJSON<ClinicalAiGovernanceReport>("/admin/clinical-ai/governance-report", { days });
}

// Clinical AI module-surface exports
export {
  acknowledgeVirtualWardEscalation,
  concludePromptExperiment,
  deactivateCanaryCase,
  decideAntimicrobialStewardshipReview,
  decideAppealLetter,
  decideChargeCaptureAudit,
  decideChartCompletionAudit,
  decideClinicalAiTask,
  decideDocumentIntake,
  decideFamilyUpdate,
  decideImagingFinding,
  decideInfectionControlAudit,
  decideLabAutoverification,
  decideNursingAmbientSession,
  decidePayerVarianceReview,
  decidePediatricDoseCheck,
  decidePolypharmacyReview,
  decidePrivacySentinelAudit,
  decideRcaDraft,
  decideSepsisBundleAudit,
  decideStaffBurnoutReview,
  decideTeachBackSession,
  decideTrialMatch,
  discardRosterRun,
  evaluateClaimVariance,
  evaluateLabAutoverification,
  evaluatePediatricDose,
  evaluateStaffBurnout,
  archiveKnowledgeBase,
  createInlineKnowledgeDocument,
  createKnowledgeBase,
  deleteKnowledgeDocument,
  exportReadinessPack,
  extractClinicalAiTasks,
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
  reviewPreopChecklist,
  draftSurgicalConsent,
  draftOperativeNote,
  draftPostOpInstructions,
  summarizeSurgicalRisk,
  runAnesthesiaPrecheck,
  trackImplantsAndConsumables,
  detectPostOpComplications,
  createTeleconsultation,
  listTeleconsultations,
  transitionTeleconsultation,
  generateTeleconsultPreVisitSummary,
  generateTeleconsultNoteDraft,
  getKnowledgeBase,
  grantKnowledgeAccess,
  listKnowledgeAccessPolicies,
  listKnowledgeBases,
  listKnowledgeDocuments,
  listKnowledgeRetrievalLogs,
  reindexKnowledgeDocument,
  retrieveFromKnowledgeBases,
  revokeKnowledgeAccess,
  unarchiveKnowledgeBase,
  updateKnowledgeBase,
  uploadKnowledgeBaseDocument,
  generateAbnormalResultTriage,
  generateAdmissionAiDraft,
  generateAntimicrobialStewardshipReview,
  generateAppealLetter,
  generateChartCompletionAudit,
  generateFamilyUpdate,
  generateInfectionControlAudit,
  generatePriorAuthorization,
  generateRcaDraft,
  generateRosterSuggestion,
  generateSepsisBundleAudit,
  generateTeachBackSession,
  getAiRoiMetrics,
  getBedDischargeForecast,
  getImagingPacsStatus,
  getLatestAiRoiSnapshot,
  getPharmacyStockoutForecast,
  importImagingStudyFromPacs,
  ingestDocumentIntake,
  ingestImagingInference,
  listAbnormalResultTriages,
  listAiRoiSnapshots,
  listAmbientEncounters,
  listAntimicrobialStewardshipReviews,
  listAppealLetters,
  listCanaryCases,
  listCanaryRuns,
  listChargeCaptureAudits,
  listChartCompletionAudits,
  listClinicalAiTasks,
  listDeteriorationSnapshots,
  listDocumentIntakes,
  listFamilyUpdates,
  listImagingFindings,
  listInfectionControlAudits,
  listLabAutoverifications,
  listNursingAmbientSessions,
  listPayerContracts,
  listPayerVarianceReviews,
  listPediatricDoseChecks,
  listPolypharmacyReviews,
  listPriorAuthorizations,
  listPrivacySentinelAudits,
  listPromptExperiments,
  listRcaDrafts,
  listRosterRuns,
  listSepsisBundleAudits,
  listStaffBurnoutReviews,
  listTeachBackSessions,
  listTrialMatches,
  listTrialSyncRuns,
  listVirtualWardEnrollments,
  listVirtualWardEscalations,
  markFamilyUpdateSent,
  matchPatientAgainstTrials,
  predictOtCaseTime,
  publishRosterRun,
  recordAppealPayerResponse,
  recordPriorAuthPayerDecision,
  registerImagingStudy,
  resolveVirtualWardEscalation,
  runCanary,
  runPrivacySentinelScan,
  saveAiRoiSnapshot,
  scoreNoShowRisk,
  submitAppealLetter,
  submitPriorAuthorization,
  triggerTrialCatalogSync,
  uploadDocumentIntake,
  upsertCanaryCase,
  upsertPayerContract
} from "./clinicalAiModules";

export type {
  AbnormalResultTriageDraft,
  AbnormalTriageBand,
  AdmissionAiDraftModuleKey,
  AiRoiByModule,
  AiRoiMetrics,
  AiRoiSnapshot,
  AmbientEncounter,
  AntimicrobialStewardshipDecision,
  AntimicrobialStewardshipReview,
  AntimicrobialStewardshipRiskBand,
  AppealDenialClassification,
  AppealLetter,
  AppealLetterDecision,
  AppealLetterStatus,
  AppealType,
  BedDischargeForecast,
  CanaryBiasSeverity,
  CanaryBiasSignal,
  CanaryCase,
  CanaryRunSummary,
  CanarySliceAttributes,
  CanarySliceMetric,
  KnowledgeAccessPolicy,
  KnowledgeBase,
  KnowledgeBasePermission,
  KnowledgeBaseStatus,
  KnowledgeBaseType,
  KnowledgeDocument,
  KnowledgeDocumentIngestResult,
  KnowledgeDocumentSourceType,
  KnowledgeDocumentStatus,
  KnowledgeRetrievalChunk,
  KnowledgeRetrievalLog,
  KnowledgeRetrievalResult,
  PatientExplainerCitation,
  PatientExplainerDraft,
  PatientExplainerKeyPoint,
  PatientExplainerLanguage,
  PatientExplainerModuleKey,
  PatientExplainerResult,
  PatientExplainerSafetyFlag,
  SurgicalAiModuleKey,
  SurgicalAiResult,
  TeleconsultAiModuleKey,
  TeleconsultAiResult,
  TeleconsultStatus,
  TeleconsultType,
  Teleconsultation,
  VideoProvider,
  ChargeCaptureAudit,
  ChartCompletionAudit,
  ChartGapRiskBand,
  ClinicalAiDraftResponse,
  ClinicalAiTaskCandidate,
  ClinicalTaskDecision,
  ClinicalTaskPriority,
  DeteriorationBand,
  DeteriorationSnapshot,
  DocumentIntake,
  FamilyCaregiverRelationship,
  FamilyUpdate,
  FamilyUpdateDecision,
  FamilyUpdateLanguage,
  FamilyUpdateStatus,
  ImagingFinding,
  ImagingInferenceItem,
  ImagingSeverity,
  InfectionControlAudit,
  InfectionControlRiskBand,
  LabAutoverification,
  LabAutoverificationDecision,
  LabAutoverificationReviewerDecision,
  LabCriticalBand,
  NoShowRiskPrediction,
  NursingAmbientDecision,
  NursingAmbientSession,
  NursingAmbientShift,
  OtCaseTimePrediction,
  PayerContract,
  PayerVarianceBand,
  PayerVarianceCategory,
  PayerVarianceDecision,
  PayerVarianceReview,
  PediatricDoseCheck,
  PediatricDoseDecision,
  PediatricSafetyBand,
  PharmacyStockoutForecast,
  PharmacyStockoutForecastItem,
  PolypharmacyReview,
  PriorAuthRequest,
  PrivacySentinelAudit,
  PrivacySentinelRiskBand,
  PromptExperiment,
  RcaCaseType,
  RcaDraftSummary,
  ReadinessPack,
  RosterCoverageGap,
  RosterPreferenceConflict,
  RosterRun,
  RosterSuggestion,
  SepsisBundleAudit,
  SepsisBundleRiskBand,
  StaffBurnoutDecision,
  StaffBurnoutReview,
  StaffBurnoutRiskBand,
  TeachBackDecision,
  TeachBackLanguage,
  TeachBackSession,
  TeachBackStatus,
  TrialMatch,
  TrialSyncRun,
  VirtualWardEnrollment,
  VirtualWardEscalation,
  VirtualWardSeverity
} from "./clinicalAiModules";
