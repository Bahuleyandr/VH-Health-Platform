import { apiFetch } from '../api-fetch';
import { APIError, deleteJSON, fetchAdminAPI, getJSON, postJSON } from './core';

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
  tenant_override_source?: 'global' | 'tenant' | string | null;
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

export type ClinicalAiModulePatch = Partial<Omit<ClinicalAiModule, 'enabled' | 'external_allowed'>> & {
  enabled?: boolean | null;
  external_allowed?: boolean | null;
};

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
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens: number;
    estimated_cost_minor?: number | null;
    avg_latency_ms?: number | null;
    last_generation_at?: string | null;
    review_count?: number;
    accepted_count?: number;
    rejected_count?: number;
    revision_count?: number;
    pending_count?: number;
    acceptance_rate_pct?: number | null;
  }>;
  by_provider: Array<{
    provider: string;
    generation_count: number;
    ai_generation_count: number;
    fallback_count?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
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
    model?: string | null;
    metadata?: Record<string, unknown>;
    created_at: string;
  }>;
}

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
  finish_reason?: string | null;
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

export type AdmissionAiDraftModuleKey =
  | 'patient_record_summary'
  | 'patient_aftercare_instructions'
  | 'medication_reconciliation'
  | 'discharge_readiness'
  | 'referral_letter'
  | 'clinical_coding_assist'
  | 'quality_case_review';

export interface ClinicalAiSourceCitation {
  source_type: string;
  source_id?: string | number | null;
  label: string;
  timestamp?: string | null;
  [key: string]: unknown;
}

export interface ClinicalAiSafetyFlagSummary {
  severity: string;
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface ClinicalAiDraftResponse<Draft = Record<string, unknown>> {
  draft: Draft;
  module_key: string;
  prompt_version: string;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  ai_metadata?: {
    provider?: string | null;
    model?: string | null;
    used_ai?: boolean;
    fallback_reason?: string | null;
    usage?: Record<string, unknown>;
    safety_review?: unknown;
    [key: string]: unknown;
  };
  review_status: string;
  review_id: number | null;
  generation_id: number | null;
  draft_generation_id?: number | null;
  requires_signoff: boolean;
}

export async function getClinicalAiConfig() { return getJSON<ClinicalAiConfig>('/emr/clinical-ai/config'); }
export async function getClinicalAiStatus(days = 7) {
  return getJSON<ClinicalAiStatus>('/admin/clinical-ai/status', { days });
}
export async function getClinicalAiModules() {
  return getJSON<{ modules: ClinicalAiModule[]; count: number }>('/admin/clinical-ai/modules');
}
export async function getClinicalAiTenantModules() {
  return getJSON<{ modules: ClinicalAiModule[]; count: number }>('/admin/clinical-ai/tenant-modules');
}
export async function updateClinicalAiModule(moduleKey: string, payload: ClinicalAiModulePatch) {
  return fetchAdminAPI<ClinicalAiModule>(`/admin/clinical-ai/modules/${encodeURIComponent(moduleKey)}`, {
    method: 'PATCH',
    body: payload,
  });
}
export async function updateClinicalAiTenantModule(moduleKey: string, payload: ClinicalAiModulePatch) {
  return fetchAdminAPI<ClinicalAiModule>(`/admin/clinical-ai/tenant-modules/${encodeURIComponent(moduleKey)}`, {
    method: 'PATCH',
    body: payload,
  });
}
export async function resetClinicalAiTenantModule(moduleKey: string) {
  return deleteJSON<ClinicalAiModule>(`/admin/clinical-ai/tenant-modules/${encodeURIComponent(moduleKey)}`);
}
export async function updateClinicalAiGuardrails(payload: Partial<ClinicalAiGuardrails>) {
  return fetchAdminAPI<{ guardrails: ClinicalAiGuardrails; budget: ClinicalAiBudgetStatus }>(
    '/admin/clinical-ai/guardrails',
    {
      method: 'PATCH',
      body: payload,
    }
  );
}
export async function generateHandoverDraft(patientUid: string) {
  return postJSON('/clinical/handover/generate', { patient_uid: patientUid });
}
export async function createDowntimeSnapshot(patientUid: string, hoursToLive = 12) {
  return postJSON(`/emr/downtime-snapshot/${patientUid}`, { hours_to_live: hoursToLive });
}
export async function getClinicalAiGenerations() {
  return getJSON<{ generations: ClinicalAiGeneration[]; count: number }>('/admin/clinical-ai/generations');
}
export async function getClinicalAiSafetyFlags() {
  return getJSON<{ flags: ClinicalAiSafetyFlag[]; count: number }>('/admin/clinical-ai/safety-flags');
}
export async function getClinicalAiSafetyReviewSummary(days = 7) {
  return getJSON<ClinicalAiSafetyReviewSummary>('/admin/clinical-ai/safety-reviews/summary', { days });
}
export async function getClinicalAiAuditLogs(limit = 50) {
  return getJSON<{ logs: ClinicalAiAuditLog[]; count: number }>('/admin/clinical-ai/audit', { limit });
}

export async function generateAdmissionAiDraft(admissionId: number, moduleKey: AdmissionAiDraftModuleKey) {
  const pathByModule: Record<AdmissionAiDraftModuleKey, string> = {
    patient_record_summary: `/emr/${admissionId}/ai/patient-record-summary`,
    patient_aftercare_instructions: `/emr/${admissionId}/aftercare-instructions`,
    medication_reconciliation: `/emr/${admissionId}/medication-reconciliation`,
    discharge_readiness: `/emr/${admissionId}/discharge-readiness`,
    referral_letter: `/emr/${admissionId}/referral-letter`,
    clinical_coding_assist: `/emr/${admissionId}/clinical-coding-assist`,
    quality_case_review: `/emr/${admissionId}/quality-case-review`,
  };
  const endpoint = pathByModule[moduleKey];
  return moduleKey === 'discharge_readiness'
    ? getJSON<ClinicalAiDraftResponse>(endpoint)
    : postJSON<ClinicalAiDraftResponse>(endpoint, {});
}

// ---------------------------------------------------------------------------
// Clinical AI governance — prompt registry, reviews, approvals, break-glass
// ---------------------------------------------------------------------------
export interface ClinicalAiPrompt {
  id: number;
  module_key: string;
  version: string;
  title: string | null;
  system_prompt: string;
  user_prompt_template: string;
  output_schema: Record<string, unknown>;
  status: string;
  active: boolean;
  created_by?: string | null;
  activated_by?: string | null;
  activated_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface ClinicalAiReview {
  id: number;
  generation_id: number | null;
  module_key: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  reviewer_uid: string | null;
  reviewer_role: string | null;
  decision: string;
  edited_draft: Record<string, unknown> | null;
  rejection_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  provider?: string | null;
  model?: string | null;
  total_tokens?: number | null;
  safety_flags?: Array<{ severity: string; code: string; message: string }>;
}

export interface ClinicalAiApproval {
  id: number;
  approval_type: string;
  module_key: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string | null;
  approved_by: string | null;
  rejected_by: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  expires_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at?: string;
}

export interface ClinicalAiBreakGlassSession {
  id: number;
  scope: string;
  reason: string;
  status: 'active' | 'ended';
  started_by: string | null;
  approved_by: string | null;
  expires_at: string;
  ended_at?: string | null;
  created_at: string;
}

export interface ClinicalAiGovernanceReport {
  report_version: string;
  generated_at: string;
  generated_by: {
    uid?: string | null;
    role?: string | null;
  };
  tenant: {
    id?: string | null;
    region?: string | null;
  };
  window_days: number;
  summary: {
    module_count: number;
    enabled_module_count: number;
    high_risk_enabled_count: number;
    external_enabled_module_count: number;
    pending_approval_count: number;
    active_break_glass_count: number;
    safety_review_count: number;
    blocked_safety_review_count: number;
    adapter_configured_count: number;
    adapter_blocked_count: number;
    total_tokens: number;
    estimated_cost_minor: number;
    audit_event_count: number;
  };
  runtime: {
    provider_health: ClinicalAiStatus['providerHealth'];
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
  prompts: {
    prompts: ClinicalAiPrompt[];
    count: number;
  };
  approvals: {
    pending: ClinicalAiApproval[];
    recent: ClinicalAiApproval[];
    pending_count: number;
    recent_count: number;
  };
  reviews: {
    reviews: ClinicalAiReview[];
    count: number;
  };
  safety_reviews: ClinicalAiSafetyReviewSummary;
  break_glass: {
    sessions: ClinicalAiBreakGlassSession[];
    count: number;
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
  data_boundaries: {
    external_ai_enabled: boolean;
    external_regions?: string | null;
    decision_support_only: boolean;
    human_review_required: boolean;
  };
}

export async function getClinicalAiPrompts(params: { moduleKey?: string; status?: string } = {}) {
  const query: Record<string, string | number> = {};
  if (params.moduleKey) query.module_key = params.moduleKey;
  if (params.status) query.status = params.status;
  return getJSON<{ prompts: ClinicalAiPrompt[]; count: number }>('/admin/clinical-ai/prompts', query);
}

export async function createClinicalAiPrompt(payload: {
  module_key: string;
  version?: string;
  title?: string;
  system_prompt: string;
  user_prompt_template: string;
  output_schema?: Record<string, unknown>;
}) {
  return postJSON<ClinicalAiPrompt>('/admin/clinical-ai/prompts', payload);
}

export async function activateClinicalAiPrompt(promptId: number, approvalId?: number) {
  return fetchAdminAPI<{ approval_required: boolean; approval?: ClinicalAiApproval; prompt: ClinicalAiPrompt }>(
    `/admin/clinical-ai/prompts/${promptId}/activate`,
    {
      method: 'PATCH',
      body: approvalId ? { approval_id: approvalId } : {},
    }
  );
}

export async function getClinicalAiReviews(params: { decision?: string; moduleKey?: string; reviewerRole?: string } = {}) {
  const query: Record<string, string | number> = {};
  if (params.decision) query.decision = params.decision;
  if (params.moduleKey) query.module_key = params.moduleKey;
  if (params.reviewerRole) query.reviewer_role = params.reviewerRole;
  return getJSON<{ reviews: ClinicalAiReview[]; count: number }>('/admin/clinical-ai/reviews', query);
}

export async function updateClinicalAiReview(
  reviewId: number,
  payload: { decision: string; edited_draft?: Record<string, unknown>; rejection_reason?: string }
) {
  return fetchAdminAPI<ClinicalAiReview>(`/admin/clinical-ai/reviews/${reviewId}`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function getClinicalAiApprovals(params: { status?: string; moduleKey?: string } = {}) {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.moduleKey) query.module_key = params.moduleKey;
  return getJSON<{ approvals: ClinicalAiApproval[]; count: number }>('/admin/clinical-ai/approvals', query);
}

export async function decideClinicalAiApproval(
  approvalId: number,
  decision: 'approved' | 'rejected',
  reason?: string
) {
  return fetchAdminAPI<ClinicalAiApproval>(`/admin/clinical-ai/approvals/${approvalId}`, {
    method: 'PATCH',
    body: { decision, reason },
  });
}

export async function getActiveBreakGlassSessions() {
  return getJSON<{ sessions: ClinicalAiBreakGlassSession[]; count: number }>('/admin/clinical-ai/break-glass');
}

export async function getClinicalAiGovernanceReport(days = 30) {
  return getJSON<ClinicalAiGovernanceReport>('/admin/clinical-ai/governance-report', { days });
}

export async function startBreakGlassSession(payload: { scope?: string; reason: string; expires_in_hours?: number }) {
  return postJSON<ClinicalAiBreakGlassSession>('/admin/clinical-ai/break-glass', payload);
}

export async function endBreakGlassSession(sessionId: number) {
  return fetchAdminAPI<ClinicalAiBreakGlassSession>(`/admin/clinical-ai/break-glass/${sessionId}/end`, {
    method: 'PATCH',
    body: {},
  });
}

export interface SelfHealingFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  code: string;
  message: string;
  suggested_action?: string;
  metadata?: Record<string, unknown>;
}

export interface SelfHealingRun {
  id: number;
  tenant_id: string;
  started_by: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'failed';
  scope: string;
  findings: SelfHealingFinding[];
  suggested_actions: Array<{ action: string }>;
  metadata: Record<string, unknown>;
}

export async function runSelfHealingScan(scope: string = 'routine') {
  return postJSON<{
    run_id: number | null;
    tenant_id: string;
    findings: SelfHealingFinding[];
    suggested_actions: Array<{ action: string }>;
    read_only: boolean;
  }>('/admin/clinical-ai/self-healing/runs', { scope });
}

export async function listSelfHealingRuns() {
  return getJSON<{ runs: SelfHealingRun[]; count: number }>('/admin/clinical-ai/self-healing/runs');
}

export interface CorpusBySource {
  source_type: string;
  chunk_count: number;
  document_count: number;
  oldest_signed: string | null;
  newest_signed: string | null;
  expired_chunks: number;
}

export interface CorpusHealth {
  by_source_type: CorpusBySource[];
  total_chunks: number;
  corpus_available: boolean;
}

export interface CorpusRetrievalRow {
  id: number;
  source_type: string;
  source_id: string;
  patient_uid: string | null;
  content: string;
  metadata: Record<string, unknown>;
  signed_at: string | null;
  similarity: number;
}

export async function getCorpusHealth() {
  return getJSON<CorpusHealth>('/admin/clinical-ai/corpus');
}

export async function reindexCorpus(limit = 200) {
  return postJSON<{ indexed: number; skipped: number; halted: boolean; reason?: string }>(
    '/admin/clinical-ai/corpus/reindex',
    { limit }
  );
}

export async function testCorpusQuery(payload: {
  query: string;
  source_type?: string;
  top_k?: number;
  min_score?: number;
}) {
  return postJSON<{ results: CorpusRetrievalRow[]; source: string }>(
    '/admin/clinical-ai/corpus/test-query',
    payload
  );
}

export interface DeadLetterRow {
  id: number;
  patient_uid: string | null;
  patient_name: string | null;
  admission_id: number | null;
  task_type: string;
  module_key: string;
  provider: string;
  model: string | null;
  status: string;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function getDeadLetterQueue() {
  return getJSON<{ generations: DeadLetterRow[]; count: number }>('/admin/clinical-ai/dead-letter');
}

export interface TranslationFidelityFlag {
  severity: string;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface TranslationRow {
  id: number;
  source_generation_id: number;
  source_language: string;
  target_language: string;
  provider: string;
  model: string | null;
  status: 'completed' | 'failed' | 'needs_review';
  fidelity_flags: TranslationFidelityFlag[];
  module_key: string | null;
  patient_uid: string | null;
  created_at: string;
}

export async function getClinicalAiTranslations(language?: string) {
  const query: Record<string, string> = {};
  if (language) query.language = language;
  return getJSON<{ translations: TranslationRow[]; count: number }>(
    '/admin/clinical-ai/translations',
    query
  );
}

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

export interface LongitudinalRiskSnapshot {
  id: number;
  admission_id: number;
  patient_uid: string | null;
  patient_name: string | null;
  overall_score: number;
  band: RiskBand;
  adherence_score: number | null;
  adherence_source: string | null;
  readmission_score: number | null;
  comorbidity_score: number | null;
  abdm_enrichment: Record<string, unknown>;
  recommendations: Array<{ severity: string; category: string; message: string }>;
  created_at: string;
}

export async function getLongitudinalRiskOverview(band?: RiskBand) {
  const query: Record<string, string> = {};
  if (band) query.band = band;
  return getJSON<{ snapshots: LongitudinalRiskSnapshot[]; count: number }>(
    '/admin/clinical-ai/longitudinal-risk',
    query
  );
}

// ---------------------------------------------------------------------------
// Governance: prompt A/B experiments + drift canary
// ---------------------------------------------------------------------------
export interface PromptExperiment {
  id: number;
  module_key: string;
  name: string;
  variant_a_prompt_id: number;
  variant_b_prompt_id: number;
  traffic_split_a: number;
  status: 'draft' | 'running' | 'paused' | 'concluded';
  started_at: string | null;
  concluded_at: string | null;
  winning_variant: 'A' | 'B' | null;
  created_at: string;
}

export interface PromptExperimentVariantStats {
  total_assignments: number;
  accepted_count?: number;
  rejected_count?: number;
  revision_count?: number;
  acceptance_rate_pct?: number | null;
  avg_tokens?: number | null;
  avg_latency_ms?: number | null;
  avg_flags?: number;
}

export interface PromptExperimentStats {
  variant_a: PromptExperimentVariantStats;
  variant_b: PromptExperimentVariantStats;
  winner_hint: 'A' | 'B' | null;
}

export async function listPromptExperiments(status?: string) {
  const query: Record<string, string> = {};
  if (status) query.status = status;
  return getJSON<{ experiments: PromptExperiment[]; count: number }>(
    '/admin/clinical-ai/experiments',
    query
  );
}

export async function createPromptExperiment(payload: {
  module_key: string;
  name?: string;
  variant_a_prompt_id: number;
  variant_b_prompt_id: number;
  traffic_split_a?: number;
}) {
  return postJSON<PromptExperiment>('/admin/clinical-ai/experiments', payload);
}

export async function getPromptExperimentStats(id: number) {
  return getJSON<PromptExperimentStats>(`/admin/clinical-ai/experiments/${id}/stats`);
}

export async function concludePromptExperiment(id: number, winningVariant?: 'A' | 'B') {
  return fetchAdminAPI<PromptExperiment>(`/admin/clinical-ai/experiments/${id}/conclude`, {
    method: 'PATCH',
    body: winningVariant ? { winning_variant: winningVariant } : {},
  });
}

export interface CanarySliceAttributes {
  age_band?: string;
  sex?: string;
  language?: string;
  disease_group?: string;
  facility_id?: string;
  [key: string]: string | undefined;
}

export interface CanarySliceMetric {
  axis: string;
  value: string;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  pass_rate_pct: number;
}

export type CanaryBiasSeverity = "critical" | "high" | "medium";

export interface CanaryBiasSignal {
  severity: CanaryBiasSeverity;
  axis: string;
  value: string;
  sample_count: number;
  pass_rate_pct: number;
  overall_pass_rate_pct: number;
  delta_pct: number;
  message: string;
}

export interface CanaryRunSummary {
  id: number;
  run_scope: string;
  total_cases: number;
  pass_count: number;
  fail_count: number;
  drift_detected: boolean;
  metadata: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  slice_metrics?: CanarySliceMetric[];
  bias_signals?: CanaryBiasSignal[];
}

export interface CanaryCase {
  id: number;
  module_key: string;
  label: string;
  input_packet?: Record<string, unknown>;
  expected_keys: string[];
  expected_citations_min: number;
  active: boolean;
  created_at: string;
  slice_attributes?: CanarySliceAttributes;
}

export interface CanaryCasePayload {
  module_key: string;
  label: string;
  input_packet: Record<string, unknown>;
  expected_keys?: string[];
  expected_citations_min?: number;
  slice_attributes?: CanarySliceAttributes;
}

export async function listCanaryCases(params: { moduleKey?: string; active?: boolean; limit?: number } = {}) {
  const query: Record<string, string | number | boolean> = {};
  if (params.moduleKey) query.module_key = params.moduleKey;
  if (params.active != null) query.active = params.active;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ cases: CanaryCase[]; count: number }>('/admin/clinical-ai/canary/cases', query);
}

export async function listCanaryRuns() {
  return getJSON<{ runs: CanaryRunSummary[]; count: number }>('/admin/clinical-ai/canary/runs');
}

export async function runCanary() {
  return postJSON<{
    total_cases: number;
    pass_count: number;
    fail_count: number;
    pass_rate_pct?: number;
    baseline_pct?: number | null;
    drift_detected: boolean;
    findings: Array<{ case_id?: number; label: string; module_key: string; passed: boolean }>;
    slice_metrics?: CanarySliceMetric[];
    bias_signals?: CanaryBiasSignal[];
  }>('/admin/clinical-ai/canary/runs', { scope: 'manual' });
}

export async function upsertCanaryCase(payload: CanaryCasePayload) {
  return postJSON<CanaryCase>('/admin/clinical-ai/canary/cases', payload);
}

export async function deactivateCanaryCase(id: number) {
  return fetchAdminAPI<CanaryCase>(`/admin/clinical-ai/canary/cases/${id}/deactivate`, {
    method: 'PATCH',
    body: {},
  });
}

// ---------------------------------------------------------------------------
// Regulatory readiness pack (S5)
// ---------------------------------------------------------------------------
export interface ReadinessPack {
  pack_version: string;
  generated_at: string;
  generated_by: { uid: string | null; role: string | null } | null;
  tenant_id: string;
  module_key: string;
  version_range: { from: string | null; to: string | null };
  decision_support_only: true;
  summary: {
    row_counts: Record<string, number>;
    bias_signal_counts: { critical: number; high: number; medium: number };
    skipped_sections: Record<string, string>;
  };
  sections: {
    module: Record<string, unknown> | null;
    model_registry: Array<Record<string, unknown>>;
    eval_runs: Array<Record<string, unknown>>;
    canary_runs: Array<Record<string, unknown>>;
    safety_reviews: Array<Record<string, unknown>>;
    prompts: Array<Record<string, unknown>>;
    reviews: Array<Record<string, unknown>>;
  };
}

export async function exportReadinessPack(payload: {
  module_key: string;
  from_version?: string | null;
  to_version?: string | null;
}) {
  return postJSON<ReadinessPack>('/admin/clinical-ai/readiness-pack', payload);
}

// ---------------------------------------------------------------------------
// Operational AI: capacity forecasting, no-show, OT duration, and charge capture
// ---------------------------------------------------------------------------
export type OperationalRiskBand = 'low' | 'medium' | 'high';

export interface BedForecastPatient {
  admission_id: number;
  patient_uid: string;
  ward: string | null;
  bed_number: string | null;
  likely_discharge_24h: boolean;
  likely_discharge_48h: boolean;
  remaining_hours_estimate: number;
}

export interface BedDischargeForecast {
  ward: string;
  forecast_window_hours: number;
  admitted_count: number;
  likely_discharges_24h: number;
  likely_discharges_48h: number;
  patients: BedForecastPatient[];
  generated_at: string;
}

export interface PharmacyStockoutForecastItem {
  medication_name: string;
  order_count: number;
  risk_level: OperationalRiskBand;
  recommended_action: string;
}

export interface PharmacyStockoutForecast {
  window_days: number;
  high_usage_meds: PharmacyStockoutForecastItem[];
  stockout_risks: PharmacyStockoutForecastItem[];
  generated_at: string;
}

export async function getBedDischargeForecast(params: { ward?: string; windowHours?: number } = {}) {
  const query: Record<string, string | number> = {};
  if (params.ward) query.ward = params.ward;
  if (params.windowHours) query.window_hours = params.windowHours;
  return getJSON<BedDischargeForecast>('/admin/forecast/beds', query);
}

export async function getPharmacyStockoutForecast(days = 7) {
  return getJSON<PharmacyStockoutForecast>('/admin/forecast/pharmacy-stockouts', { days });
}

export interface NoShowRiskPrediction {
  appointment_id: number;
  risk_score: number;
  band: OperationalRiskBand;
  contributors: Record<string, unknown>;
  recommended_action: string;
  module_key: string;
  decision_support_only: boolean;
}

export interface OtCaseTimePrediction {
  ot_schedule_id: number;
  procedure_name: string | null;
  predicted_minutes: number;
  confidence_pct: number;
  sample_size: number;
  contributors: Record<string, unknown>;
  module_key: string;
  decision_support_only: boolean;
}

export async function scoreNoShowRisk(appointmentId: number) {
  return postJSON<NoShowRiskPrediction>(`/admin/clinical-ai/operational/no-show/${appointmentId}`, {});
}

export async function predictOtCaseTime(scheduleId: number) {
  return postJSON<OtCaseTimePrediction>(`/admin/clinical-ai/operational/ot/${scheduleId}`, {});
}

export interface ChargeCaptureAudit {
  id: number;
  admission_id: number;
  patient_uid: string | null;
  mentioned_codes: Array<{ code: string; description: string }>;
  missed_codes: Array<{ code: string; description: string; est_revenue_minor: number }>;
  estimated_revenue_minor: number;
  reviewer_decision: 'pending' | 'captured' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  scanned_at: string;
}

export async function listChargeCaptureAudits(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ audits: ChargeCaptureAudit[]; count: number }>(
    '/admin/clinical-ai/operational/charge-capture',
    query
  );
}

export async function decideChargeCaptureAudit(id: number, decision: 'captured' | 'rejected') {
  return fetchAdminAPI<ChargeCaptureAudit>(`/admin/clinical-ai/operational/charge-capture/${id}`, {
    method: 'PATCH',
    body: { decision },
  });
}

// ---------------------------------------------------------------------------
// Clinical safety: deterioration snapshots + polypharmacy reviews
// ---------------------------------------------------------------------------
export type DeteriorationBand = 'stable' | 'watch' | 'concerning' | 'critical';

export interface DeteriorationSnapshot {
  id: number;
  patient_uid: string;
  admission_id: number | null;
  score: number;
  band: DeteriorationBand;
  news2_component: number;
  trend_component: number;
  lab_component: number;
  contributors: Record<string, unknown>;
  recommendations: Array<{ severity: string; message: string }>;
  vitals_sample_count: number;
  scored_at: string;
}

export async function listDeteriorationSnapshots(band?: DeteriorationBand) {
  const query: Record<string, string> = {};
  if (band) query.band = band;
  return getJSON<{ snapshots: DeteriorationSnapshot[]; count: number }>(
    '/admin/clinical-ai/safety/deterioration',
    query
  );
}

export interface PolypharmacyReview {
  id: number;
  patient_uid: string;
  admission_id: number | null;
  medications: Array<{ name?: string; medication_name?: string; dose?: string; frequency?: string }>;
  rule_findings: Array<{ severity: string; code: string; message: string; source: string }>;
  ai_findings: Array<{ severity: string; code: string; message: string; source: string }>;
  combined_severity: 'low' | 'medium' | 'high' | 'critical';
  provider: string;
  reviewer_decision: 'pending' | 'acknowledged' | 'overridden' | 'prescription_changed';
  reviewer_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  scored_at: string;
}

export async function listPolypharmacyReviews(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ reviews: PolypharmacyReview[]; count: number }>(
    '/admin/clinical-ai/safety/polypharmacy',
    query
  );
}

export async function decidePolypharmacyReview(id: number, decision: 'acknowledged' | 'overridden' | 'prescription_changed', note?: string) {
  return fetchAdminAPI<PolypharmacyReview>(`/admin/clinical-ai/safety/polypharmacy/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Research: trial matches + RCA drafts
// ---------------------------------------------------------------------------
export interface TrialMatch {
  id: number;
  patient_uid: string;
  patient_name: string | null;
  admission_id: number | null;
  trial_id: number;
  nct_id: string;
  title: string;
  phase: string | null;
  match_score: number;
  match_reasons: Array<{ kind: string; [key: string]: unknown }>;
  coordinator_decision: 'pending' | 'offered' | 'enrolled' | 'declined' | 'ineligible';
  decided_by: string | null;
  decided_at: string | null;
  scored_at: string;
}

export interface TrialMatchRunResponse {
  patient_uid: string;
  admission_id: number | string | null;
  patient_profile?: { age?: number | null; gender?: string | null; diagnosis_count?: number };
  matches: Array<{
    trial_id: number;
    nct_id: string;
    title: string;
    phase: string | null;
    match_score: number;
    match_reasons: Array<{ kind: string; [key: string]: unknown }>;
    location: string | null;
  }>;
  persisted_count: number;
  note?: string;
  module_key?: string;
  decision_support_only?: boolean;
}

export async function listTrialMatches(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ matches: TrialMatch[]; count: number }>(
    '/admin/clinical-ai/trials/matches',
    query
  );
}

export async function matchPatientAgainstTrials(patientUid: string, payload: { admission_id?: string | number; min_score?: number; limit?: number } = {}) {
  return postJSON<TrialMatchRunResponse>(`/admin/clinical-ai/trials/match/${patientUid}`, payload);
}

export async function decideTrialMatch(id: number, decision: 'offered' | 'enrolled' | 'declined' | 'ineligible') {
  return fetchAdminAPI<TrialMatch>(`/admin/clinical-ai/trials/matches/${id}`, {
    method: 'PATCH',
    body: { decision },
  });
}

export interface TrialSyncRun {
  id: number;
  source: string;
  query_conditions: string[];
  query_location: string | null;
  status: 'running' | 'completed' | 'failed';
  fetched_count: number;
  upserted_count: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export async function triggerTrialCatalogSync(payload: { conditions?: string[]; location?: string; max_results?: number } = {}) {
  return postJSON<{
    run_id: number | null;
    status: string;
    source: string;
    query_conditions: string[];
    query_location: string | null;
    fetched_count: number;
    upserted_count: number;
    error_message: string | null;
  }>('/admin/clinical-ai/trials/sync', payload);
}

export async function listTrialSyncRuns() {
  return getJSON<{ runs: TrialSyncRun[]; count: number }>('/admin/clinical-ai/trials/sync');
}

export type ImagingSeverity = 'normal' | 'incidental' | 'actionable' | 'critical' | 'unreadable';

export interface ImagingStudy {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  study_instance_uid: string;
  modality: string;
  body_part: string | null;
  study_date: string | null;
  pacs_url: string | null;
  created_at: string;
}

export interface ImagingFinding {
  id: number;
  study_id: number;
  provider: string;
  model: string | null;
  overall_severity: ImagingSeverity;
  confidence_pct: number | null;
  findings: Array<{ label: string; confidence: number; severity: string; actionable: boolean }>;
  narrative_draft: string | null;
  heatmap_url: string | null;
  radiologist_decision: 'pending' | 'confirmed' | 'revised' | 'rejected' | 'escalated';
  reviewed_at: string | null;
  created_at: string;
  patient_uid: string | null;
  patient_name: string | null;
  modality: string;
  body_part: string | null;
  study_date: string | null;
  study_instance_uid: string;
}

export interface ImagingPacsStatus {
  configured: boolean;
  reason: string | null;
  provider: string | null;
  api_mode: string | null;
  base_url_configured: boolean;
  auth_configured: boolean;
  timeout_ms: number | null;
  tenant_region: string | null;
  allowed_regions: string[];
}

export interface ImagingPacsImportResponse {
  imported: boolean;
  pacs_status: string;
  reason?: string | null;
  provider?: string | null;
  api_mode?: string | null;
  config?: ImagingPacsStatus | null;
  study?: ImagingStudy | null;
  pacs_metadata?: Record<string, unknown> | null;
  module_key: string;
  decision_support_only: boolean;
}

export type ImagingInferenceItem = {
  label: string;
  confidence: number;
  severity?: string;
  actionable?: boolean;
  [key: string]: unknown;
};

export interface ImagingInferenceResponse {
  finding_id: number | null;
  study_id: number;
  study_instance_uid: string;
  generation_id: number | null;
  findings: Array<{ label: string; confidence: number; severity: string; actionable: boolean }>;
  overall_severity: ImagingSeverity;
  confidence_pct: number | null;
  narrative_draft: string | null;
  heatmap_url: string | null;
  safety_flags: Array<Record<string, unknown>>;
  radiologist_decision: 'pending';
  module_key: string;
  decision_support_only: boolean;
}

export async function getImagingPacsStatus() {
  return getJSON<ImagingPacsStatus>('/admin/clinical-ai/imaging/pacs/status');
}

export async function registerImagingStudy(payload: {
  patient_uid: string;
  admission_id?: string | number;
  study_instance_uid: string;
  modality: string;
  body_part?: string;
  study_date?: string;
  series_count?: number;
  instance_count?: number;
  pacs_url?: string;
  storage_key?: string;
  source_system?: string;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<ImagingStudy>('/admin/clinical-ai/imaging/studies', payload);
}

export async function importImagingStudyFromPacs(payload: {
  patient_uid: string;
  admission_id?: string | number;
  study_instance_uid?: string;
  accession_number?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}) {
  return postJSON<ImagingPacsImportResponse>('/admin/clinical-ai/imaging/studies/import-pacs', payload);
}

export async function ingestImagingInference(payload: {
  study_instance_uid: string;
  provider: string;
  model?: string;
  model_version?: string;
  results: ImagingInferenceItem[];
  heatmap_url?: string;
  raw_provider_payload?: Record<string, unknown> | null;
}) {
  return postJSON<ImagingInferenceResponse>('/admin/clinical-ai/imaging/inference', payload);
}

export async function listImagingFindings(params: { decision?: string; severity?: ImagingSeverity } = {}) {
  const query: Record<string, string> = {};
  if (params.decision) query.decision = params.decision;
  if (params.severity) query.severity = params.severity;
  return getJSON<{ findings: ImagingFinding[]; count: number }>(
    '/admin/clinical-ai/imaging/findings',
    query
  );
}

export async function decideImagingFinding(id: number, decision: 'confirmed' | 'revised' | 'rejected' | 'escalated', note?: string) {
  return fetchAdminAPI<ImagingFinding>(`/admin/clinical-ai/imaging/findings/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

export type VirtualWardSeverity = 'amber' | 'red';

export interface VirtualWardEscalation {
  id: number;
  enrollment_id: number;
  check_in_id: number | null;
  patient_uid: string;
  patient_name: string | null;
  severity: VirtualWardSeverity;
  reason: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
  pathway: string | null;
  care_manager_uid: string | null;
}

export interface VirtualWardEnrollment {
  id: number;
  patient_uid: string;
  patient_name: string | null;
  admission_id: number | null;
  pathway: string;
  start_date: string;
  status: 'active' | 'graduated' | 'escalated' | 'dropped';
  expected_check_in_cadence_hours: number;
  last_check_in_at: string | null;
  open_escalations: number;
}

export async function listVirtualWardEscalations(severity?: VirtualWardSeverity) {
  const query: Record<string, string> = {};
  if (severity) query.severity = severity;
  return getJSON<{ escalations: VirtualWardEscalation[]; count: number }>(
    '/admin/clinical-ai/virtual-ward/escalations',
    query
  );
}

export async function listVirtualWardEnrollments() {
  return getJSON<{ enrollments: VirtualWardEnrollment[]; count: number }>(
    '/admin/clinical-ai/virtual-ward/enrollments'
  );
}

export async function acknowledgeVirtualWardEscalation(id: number) {
  return fetchAdminAPI<VirtualWardEscalation>(`/admin/clinical-ai/virtual-ward/escalations/${id}/acknowledge`, {
    method: 'PATCH',
    body: {},
  });
}

export async function resolveVirtualWardEscalation(id: number, resolution: string, note?: string) {
  return fetchAdminAPI<VirtualWardEscalation>(`/admin/clinical-ai/virtual-ward/escalations/${id}/resolve`, {
    method: 'PATCH',
    body: { resolution, note },
  });
}

export interface RcaDraftSummary {
  id: number;
  admission_id: number;
  patient_uid: string | null;
  case_type: 'mortality' | 'readmission' | 'infection' | 'never_event' | 'complaint';
  reviewer_decision: 'pending' | 'accepted' | 'revised' | 'rejected';
  reviewer_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export type RcaCaseType = 'mortality' | 'readmission' | 'infection' | 'never_event' | 'complaint';

export interface RcaGenerationResponse {
  rca_id: number | null;
  admission_id: number;
  case_type: RcaCaseType;
  draft: Record<string, unknown>;
  citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  used_ai: boolean;
  provider: string;
  reviewer_decision: 'pending';
  module_key: string;
  decision_support_only: boolean;
}

export async function listRcaDrafts(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ drafts: RcaDraftSummary[]; count: number }>(
    '/admin/clinical-ai/rca',
    query
  );
}

export async function generateRcaDraft(admissionId: string | number, caseType: RcaCaseType = 'mortality') {
  return postJSON<RcaGenerationResponse>(`/admin/clinical-ai/rca/${admissionId}`, { case_type: caseType });
}

export async function decideRcaDraft(id: number, decision: 'accepted' | 'revised' | 'rejected', note?: string) {
  return fetchAdminAPI<RcaDraftSummary>(`/admin/clinical-ai/rca/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Revenue cycle: prior authorization
// ---------------------------------------------------------------------------
export interface PriorAuthRequest {
  id: number;
  admission_id: number | null;
  patient_uid: string;
  payer_name: string;
  policy_number: string | null;
  procedure_code: string;
  procedure_description: string | null;
  requested_service_type: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'denied' | 'withdrawn';
  reviewer_decision: 'pending' | 'submitted' | 'rejected' | 'edited';
  payer_reference_id: string | null;
  submitted_at: string | null;
  payer_decided_at: string | null;
  payer_decision_reason: string | null;
  metadata?: {
    payer_submission?: {
      mode?: string;
      status?: string;
      reason?: string | null;
      submitted?: boolean;
      blocking?: boolean;
      reference_id?: string | null;
      http_status?: number | null;
      payer_status?: string | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface PriorAuthGeneratePayload {
  admission_id: string | number;
  payer_name: string;
  policy_number?: string | null;
  procedure_code: string;
  procedure_description?: string | null;
  requested_service_type?: string | null;
}

export interface PriorAuthGenerationResponse {
  prior_auth_id: number | null;
  tenant_id: string;
  admission_id: number;
  patient_uid: string;
  packet: Record<string, unknown>;
  citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  used_ai: boolean;
  provider: string;
  status: 'draft';
  reviewer_decision: 'pending';
  module_key: string;
  decision_support_only: boolean;
}

export async function listPriorAuthorizations(status?: string) {
  const query: Record<string, string> = {};
  if (status) query.status = status;
  return getJSON<{ prior_auths: PriorAuthRequest[]; count: number }>(
    '/admin/clinical-ai/prior-auth',
    query
  );
}

export async function generatePriorAuthorization(payload: PriorAuthGeneratePayload) {
  return postJSON<PriorAuthGenerationResponse>('/admin/clinical-ai/prior-auth', payload);
}

export async function submitPriorAuthorization(id: number, payerReferenceId?: string) {
  return fetchAdminAPI<PriorAuthRequest>(`/admin/clinical-ai/prior-auth/${id}/submit`, {
    method: 'PATCH',
    body: { payer_reference_id: payerReferenceId },
  });
}

export async function recordPriorAuthPayerDecision(id: number, decision: 'approved' | 'denied' | 'withdrawn', reason?: string) {
  return fetchAdminAPI<PriorAuthRequest>(`/admin/clinical-ai/prior-auth/${id}/payer-decision`, {
    method: 'PATCH',
    body: { decision, reason },
  });
}

// ---------------------------------------------------------------------------
// Document intelligence / OCR intake
// ---------------------------------------------------------------------------
export type DocumentIntakeDecision = 'pending' | 'accepted' | 'rejected' | 'needs_revision';

export interface DocumentIntake {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  source_type: string;
  title: string | null;
  file_name: string | null;
  mime_type: string | null;
  storage_key: string | null;
  extraction_status: 'pending' | 'completed' | 'failed' | 'needs_review' | string;
  document_type: string;
  extracted_fields: {
    medications?: Array<{ text: string; action?: string }>;
    investigations?: Array<{ text: string; kind?: string }>;
    diagnoses?: Array<{ text: string }>;
    procedures?: Array<{ text: string }>;
    follow_up?: Array<{ text: string }>;
    confidence?: number;
    line_count?: number;
    [key: string]: unknown;
  };
  normalized_sections: Record<string, unknown>;
  source_citations: Array<{ source_type: string; source_id: string; label: string; timestamp?: string | null }>;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  generation_id: number | null;
  reviewer_decision: DocumentIntakeDecision;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DocumentOcrResult {
  provider: string;
  status: string;
  mime_type: string;
  file_name: string | null;
  file_hash: string;
  file_size_bytes: number;
  text_char_count: number;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  metadata: Record<string, unknown>;
}

export interface DocumentIntakeResult {
  intake_id: number | null;
  generation_id: number | null;
  intake?: DocumentIntake | null;
  extraction_status: string;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  source_citations?: Array<{ source_type: string; source_id: string; label: string; timestamp?: string | null }>;
  used_ai: boolean;
  provider: string;
  module_key: string;
  decision_support_only: boolean;
  ocr?: DocumentOcrResult;
}

export async function listDocumentIntakes(params: {
  sourceType?: string;
  status?: string;
  patientUid?: string;
  decision?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.sourceType) query.source_type = params.sourceType;
  if (params.status) query.status = params.status;
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ documents: DocumentIntake[]; count: number }>(
    '/admin/clinical-ai/documents/intake',
    query
  );
}

export async function ingestDocumentIntake(payload: {
  patient_uid?: string | null;
  admission_id?: number | null;
  source_type?: string;
  title?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  storage_key?: string | null;
  raw_text: string;
}) {
  return postJSON<DocumentIntakeResult>('/admin/clinical-ai/documents/intake', payload);
}

export async function uploadDocumentIntake(file: File, payload: {
  patient_uid?: string | null;
  admission_id?: number | null;
  source_type?: string;
  title?: string | null;
  storage_key?: string | null;
  raw_text?: string | null;
}) {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== '') {
      form.append(key, String(value));
    }
  }
  const response = await apiFetch('/api/v1/admin/clinical-ai/documents/intake/upload', {
    method: 'POST',
    body: form,
  });
  const body = await response.json().catch(() => null) as { data?: DocumentIntakeResult; message?: string; error?: string } | null;
  if (!response.ok) {
    throw new APIError(body?.message || body?.error || `HTTP ${response.status} uploading document`, response.status, body);
  }
  return body?.data ?? (body as DocumentIntakeResult);
}

export async function decideDocumentIntake(
  id: number,
  decision: 'accepted' | 'rejected' | 'needs_revision',
  note?: string
) {
  return fetchAdminAPI<DocumentIntake>(`/admin/clinical-ai/documents/intake/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Chart completion auditor
// ---------------------------------------------------------------------------
export type ChartGapDecision = 'pending' | 'accepted' | 'deferred' | 'rejected';
export type ChartGapRiskBand = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface ChartGapItem {
  severity: string;
  code: string;
  label: string;
  owner_role?: string;
  suggested_action?: string;
  evidence?: Array<{ summary?: string; citation?: Record<string, unknown> }>;
}

export interface ChartCompletionAudit {
  id: number;
  tenant_id?: string;
  admission_id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  generation_id: number | null;
  completion_score: number;
  risk_band: ChartGapRiskBand;
  gap_summary: {
    checklist?: Record<string, boolean>;
    gap_counts?: Record<string, number>;
    summary?: string | null;
    [key: string]: unknown;
  };
  blockers: ChartGapItem[];
  recommendations: Array<{ code?: string; owner_role?: string; action?: string; priority?: string }>;
  source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  reviewer_decision: ChartGapDecision;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listChartCompletionAudits(params: {
  admissionId?: number | string;
  patientUid?: string;
  decision?: string;
  riskBand?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ audits: ChartCompletionAudit[]; count: number }>(
    '/admin/clinical-ai/chart-completion/audits',
    query
  );
}

export async function generateChartCompletionAudit(admissionId: number) {
  return postJSON<{
    audit_id: number | null;
    generation_id: number | null;
    review_id: number | null;
    draft: {
      completion_score: number;
      risk_band: ChartGapRiskBand;
      gaps: ChartGapItem[];
      recommendations: Array<{ code?: string; owner_role?: string; action?: string; priority?: string }>;
      checklist?: Record<string, boolean>;
      gap_counts?: Record<string, number>;
    };
    source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
    safety_flags: Array<{ severity: string; code: string; message: string }>;
    module_key: string;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/chart-completion/audits', { admission_id: admissionId });
}

export async function decideChartCompletionAudit(
  id: number,
  decision: 'accepted' | 'deferred' | 'rejected',
  note?: string
) {
  return fetchAdminAPI<ChartCompletionAudit>(`/admin/clinical-ai/chart-completion/audits/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Clinical task extractor
// ---------------------------------------------------------------------------
export type ClinicalTaskPriority = 'routine' | 'soon' | 'urgent' | 'critical' | 'unknown';
export type ClinicalTaskDecision = 'pending' | 'accepted' | 'rejected' | 'deferred' | 'completed';

export interface ClinicalAiTaskCandidate {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  generation_id: number | null;
  source_scope: string;
  source_event_type: string | null;
  source_event_id: string | null;
  task_title: string;
  task_description: string | null;
  category: string;
  priority: ClinicalTaskPriority;
  owner_role: string | null;
  due_hint: string | null;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: ClinicalTaskDecision;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listClinicalAiTasks(params: {
  admissionId?: number | string;
  patientUid?: string;
  decision?: string;
  priority?: string;
  ownerRole?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.priority) query.priority = params.priority;
  if (params.ownerRole) query.owner_role = params.ownerRole;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ tasks: ClinicalAiTaskCandidate[]; count: number }>(
    '/admin/clinical-ai/tasks',
    query
  );
}

export async function extractClinicalAiTasks(admissionId: number) {
  return postJSON<{
    generation_id: number | null;
    review_id: number | null;
    task_count: number;
    tasks: ClinicalAiTaskCandidate[];
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    prompt_version: string;
    review_status: string;
    requires_signoff: boolean;
    ai_metadata?: {
      provider?: string | null;
      model?: string | null;
      used_ai?: boolean;
      usage?: Record<string, unknown>;
    };
    decision_support_only: boolean;
    no_auto_assign: boolean;
  }>('/admin/clinical-ai/tasks/extract', { admission_id: admissionId });
}

export async function decideClinicalAiTask(
  id: number,
  decision: Exclude<ClinicalTaskDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<ClinicalAiTaskCandidate>(`/admin/clinical-ai/tasks/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Consent & PHI policy sentinel
// ---------------------------------------------------------------------------
export type PrivacySentinelDecision = 'pending' | 'acknowledged' | 'escalated' | 'dismissed';
export type PrivacySentinelRiskBand = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface PrivacySentinelFinding {
  severity: string;
  code: string;
  title: string;
  recommendation?: string;
  evidence?: Array<Record<string, unknown>>;
}

export interface PrivacySentinelAudit {
  id: number;
  tenant_id?: string;
  generation_id: number | null;
  patient_uid: string | null;
  patient_name?: string | null;
  module_key: string | null;
  provider: string | null;
  risk_band: PrivacySentinelRiskBand;
  risk_score: number;
  findings: PrivacySentinelFinding[];
  consent_snapshot: {
    available?: boolean;
    active_count?: number;
    active_types?: string[];
    has_treatment_consent?: boolean;
    has_data_access_consent?: boolean;
    has_ai_processing_consent?: boolean;
    latest_granted_at?: string | null;
    [key: string]: unknown;
  };
  reviewer_decision: PrivacySentinelDecision;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_note: string | null;
  metadata: Record<string, unknown>;
  generation_status?: string | null;
  generation_created_at?: string | null;
  total_tokens?: number | null;
  estimated_cost_minor?: number | null;
  created_at: string;
  updated_at: string;
}

export async function listPrivacySentinelAudits(params: {
  riskBand?: string;
  decision?: string;
  moduleKey?: string;
  patientUid?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.decision) query.decision = params.decision;
  if (params.moduleKey) query.module_key = params.moduleKey;
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ audits: PrivacySentinelAudit[]; count: number }>(
    '/admin/clinical-ai/privacy-sentinel/audits',
    query
  );
}

export async function runPrivacySentinelScan(payload: {
  generationId?: number | null;
  windowDays?: number;
  limit?: number;
} = {}) {
  return postJSON<{
    audits: PrivacySentinelAudit[];
    count: number;
    summary: {
      scanned: number;
      critical: number;
      high: number;
      medium: number;
      low: number;
      findings: number;
    };
    module_key: string;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/privacy-sentinel/scans', {
    generation_id: payload.generationId || null,
    window_days: payload.windowDays || 7,
    limit: payload.limit || 100,
  });
}

export async function decidePrivacySentinelAudit(
  id: number,
  decision: 'acknowledged' | 'escalated' | 'dismissed',
  note?: string
) {
  return fetchAdminAPI<PrivacySentinelAudit>(`/admin/clinical-ai/privacy-sentinel/audits/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Abnormal result triage worklist
// ---------------------------------------------------------------------------
export type AbnormalTriageBand = 'routine' | 'watch' | 'urgent' | 'critical';

export interface AbnormalTriageItem {
  source?: string;
  abnormalities?: string[];
  note?: string;
}

export interface AbnormalResultTriageDraft {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  module_key: string;
  provider: string;
  model?: string | null;
  status: string;
  used_ai: boolean;
  prompt_version: string;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
  draft: {
    urgent_items?: AbnormalTriageItem[];
    watch_items?: AbnormalTriageItem[];
    explanation?: string;
    [key: string]: unknown;
  };
  total_tokens?: number | null;
  estimated_cost_minor?: number | null;
  review_id?: number | null;
  review_status?: string | null;
  reviewer_uid?: string | null;
  review_updated_at?: string | null;
  summary: {
    urgency_band: AbnormalTriageBand;
    urgency_score: number;
    urgent_count: number;
    watch_count: number;
    top_urgent: AbnormalTriageItem[];
    top_watch: AbnormalTriageItem[];
    explanation: string;
  };
  created_at: string;
}

export async function listAbnormalResultTriages(params: {
  admissionId?: number | string;
  patientUid?: string;
  urgencyBand?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.urgencyBand) query.urgency_band = params.urgencyBand;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ drafts: AbnormalResultTriageDraft[]; count: number }>(
    '/admin/clinical-ai/abnormal-results/triage',
    query
  );
}

export async function generateAbnormalResultTriage(admissionId: number) {
  return postJSON<{
    draft: {
      urgent_items?: AbnormalTriageItem[];
      watch_items?: AbnormalTriageItem[];
      explanation?: string;
    };
    module_key: string;
    prompt_version: string;
    source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
    safety_flags: Array<{ severity: string; code: string; message: string }>;
    review_status: string;
    review_id: number | null;
    generation_id: number | null;
    requires_signoff: boolean;
  }>('/admin/clinical-ai/abnormal-results/triage', { admission_id: admissionId });
}

// ---------------------------------------------------------------------------
// Infection control sentinel
// ---------------------------------------------------------------------------
export type InfectionControlRiskBand = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type InfectionControlDecision = 'pending' | 'acknowledged' | 'escalated' | 'dismissed';

export interface InfectionControlSignal {
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  code: string;
  category: string;
  title: string;
  recommendation: string;
  evidence?: Array<Record<string, unknown>>;
}

export interface InfectionControlAudit {
  id: number;
  tenant_id?: string;
  admission_id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  generation_id: number | null;
  risk_score: number;
  risk_band: InfectionControlRiskBand;
  signals: InfectionControlSignal[];
  recommendations: Array<{ code: string; severity: string; recommendation: string }>;
  stewardship_flags: InfectionControlSignal[];
  isolation_flags: InfectionControlSignal[];
  source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  reviewer_decision: InfectionControlDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listInfectionControlAudits(params: {
  admissionId?: number | string;
  patientUid?: string;
  decision?: string;
  riskBand?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ audits: InfectionControlAudit[]; count: number }>(
    '/admin/clinical-ai/infection-control/audits',
    query
  );
}

export async function generateInfectionControlAudit(admissionId: number) {
  return postJSON<{
    audit_id: number | null;
    generation_id: number | null;
    review_id: number | null;
    draft: {
      risk_score: number;
      risk_band: InfectionControlRiskBand;
      signals: InfectionControlSignal[];
      recommendations: Array<{ code: string; severity: string; recommendation: string }>;
      stewardship_flags: InfectionControlSignal[];
      isolation_flags: InfectionControlSignal[];
      summary?: string;
    };
    module_key: string;
    prompt_version: string;
    source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
    safety_flags: Array<{ severity: string; code: string; message: string }>;
    review_status: string;
    requires_signoff: boolean;
  }>('/admin/clinical-ai/infection-control/audits', { admission_id: admissionId });
}

export async function decideInfectionControlAudit(id: number, decision: Exclude<InfectionControlDecision, 'pending'>, note?: string) {
  return fetchAdminAPI<InfectionControlAudit>(`/admin/clinical-ai/infection-control/audits/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Antimicrobial stewardship assistant
// ---------------------------------------------------------------------------
export type AntimicrobialStewardshipRiskBand = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type AntimicrobialStewardshipDecision = 'pending' | 'accepted' | 'deferred' | 'rejected';

export interface AntimicrobialStewardshipFlag {
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  code: string;
  category: string;
  title: string;
  recommendation: string;
  evidence?: Array<Record<string, unknown>>;
}

export interface AntimicrobialAntibioticSummary {
  medication: string;
  antibiotic: string;
  class_name: string;
  route: string | null;
  duration: string | null;
  broad_spectrum: boolean;
  renal_risk: boolean;
  status: string | null;
  source_citation?: ClinicalAiSourceCitation | null;
}

export interface AntimicrobialCultureSummary {
  test_name: string;
  status: string;
  result_summary: string | null;
  source_citation?: ClinicalAiSourceCitation | null;
}

export interface AntimicrobialStewardshipReview {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number;
  generation_id: number | null;
  stewardship_score: number;
  risk_band: AntimicrobialStewardshipRiskBand;
  antibiotic_summary: AntimicrobialAntibioticSummary[];
  culture_summary: AntimicrobialCultureSummary[];
  renal_summary: Record<string, unknown>;
  fever_summary: Record<string, unknown>;
  flags: AntimicrobialStewardshipFlag[];
  recommendations: Array<{ code: string; severity: string; recommendation: string }>;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: AntimicrobialStewardshipDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listAntimicrobialStewardshipReviews(params: {
  admissionId?: number | string;
  patientUid?: string;
  decision?: string;
  riskBand?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ reviews: AntimicrobialStewardshipReview[]; count: number }>(
    '/admin/clinical-ai/antimicrobial-stewardship/reviews',
    query
  );
}

export async function generateAntimicrobialStewardshipReview(admissionId: number) {
  return postJSON<{
    review_id: number | null;
    generation_id: number | null;
    clinical_review_id: number | null;
    draft: {
      stewardship_score: number;
      risk_band: AntimicrobialStewardshipRiskBand;
      antibiotic_summary: AntimicrobialAntibioticSummary[];
      culture_summary: AntimicrobialCultureSummary[];
      renal_summary: Record<string, unknown>;
      fever_summary: Record<string, unknown>;
      flags: AntimicrobialStewardshipFlag[];
      recommendations: Array<{ code: string; severity: string; recommendation: string }>;
      summary?: string;
    };
    module_key: string;
    prompt_version: string;
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    review_status: string;
    requires_signoff: boolean;
    rules_authoritative: boolean;
    ai_metadata?: Record<string, unknown>;
  }>('/admin/clinical-ai/antimicrobial-stewardship/reviews', { admission_id: admissionId });
}

export async function decideAntimicrobialStewardshipReview(
  id: number,
  decision: Exclude<AntimicrobialStewardshipDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<AntimicrobialStewardshipReview>(`/admin/clinical-ai/antimicrobial-stewardship/reviews/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// AI ROI dashboard
// ---------------------------------------------------------------------------
export interface AiRoiByModule {
  module_key: string;
  generation_count: number;
  ai_generation_count: number;
  fallback_count: number;
  accepted_count: number;
  rejected_count: number;
  pending_count: number;
  edited_count: number;
  total_tokens: number;
  total_cost_minor: number;
  acceptance_rate_pct: number;
  time_saved_minutes: number;
  documentation_minutes_saved: number;
  cost_per_useful_draft_minor: number;
}

export interface AiRoiHighlight {
  module_key: string;
  accepted_count: number;
  time_saved_minutes: number;
  acceptance_rate_pct: number;
  cost_per_useful_draft_minor: number;
}

export interface AiRoiMetrics {
  tenant_id: string;
  module_key: string;
  period_start: string;
  period_end: string;
  period_days: number;
  generation_count: number;
  ai_generation_count: number;
  fallback_count: number;
  accepted_count: number;
  rejected_count: number;
  pending_count: number;
  edited_count: number;
  total_tokens: number;
  total_cost_minor: number;
  acceptance_rate_pct: number;
  time_saved_minutes: number;
  documentation_hours_saved: number;
  denial_value_prevented_minor: number;
  prior_auth_approved_count: number;
  appeal_approved_count: number;
  cost_per_useful_draft_minor: number;
  by_module: AiRoiByModule[];
  highlights: AiRoiHighlight[];
  computed_at: string;
  decision_support_only: boolean;
  read_only: boolean;
}

export interface AiRoiSnapshot extends AiRoiMetrics {
  id: number;
  created_at?: string;
  computed_by?: string | null;
}

export async function getAiRoiMetrics(periodDays: number = 30) {
  return getJSON<AiRoiMetrics>('/admin/clinical-ai/roi', { period_days: String(periodDays) });
}

export async function saveAiRoiSnapshot(payload: { periodDays?: number; moduleKey?: string } = {}) {
  const body: Record<string, unknown> = {};
  if (payload.periodDays) body.period_days = payload.periodDays;
  if (payload.moduleKey) body.module_key = payload.moduleKey;
  return postJSON<{ snapshot: AiRoiSnapshot; metrics: AiRoiMetrics }>(
    '/admin/clinical-ai/roi/snapshots',
    body
  );
}

export async function listAiRoiSnapshots(params: { moduleKey?: string; limit?: number } = {}) {
  const query: Record<string, string> = {};
  if (params.moduleKey) query.module_key = params.moduleKey;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ snapshots: AiRoiSnapshot[]; count: number }>(
    '/admin/clinical-ai/roi/snapshots',
    query
  );
}

export async function getLatestAiRoiSnapshot(moduleKey: string = 'ALL') {
  return getJSON<{ snapshot: AiRoiSnapshot | null }>(
    '/admin/clinical-ai/roi/snapshots/latest',
    { module_key: moduleKey }
  );
}

// ---------------------------------------------------------------------------
// Staff burnout / workload risk
// ---------------------------------------------------------------------------
export type StaffBurnoutRiskBand = 'low' | 'moderate' | 'high' | 'critical' | 'unknown' | 'insufficient_data';
export type StaffBurnoutDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'escalated';

export interface StaffBurnoutSignal {
  code: string;
  severity: string;
  description: string;
  recommendation: string;
}

export interface StaffBurnoutReview {
  id: number;
  tenant_id?: string;
  staff_uid: string;
  staff_name?: string | null;
  department: string | null;
  role: string | null;
  window_days: number;
  window_start: string;
  window_end: string;
  total_hours: number;
  overtime_hours: number;
  night_shift_count: number;
  consecutive_night_shifts: number;
  weekend_shift_count: number;
  pto_days_taken: number;
  avg_hours_per_week: number;
  risk_score: number;
  risk_band: StaffBurnoutRiskBand;
  contributing_signals: StaffBurnoutSignal[];
  recommended_actions: string[];
  generation_id: number | null;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: StaffBurnoutDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listStaffBurnoutReviews(params: {
  staffUid?: string;
  department?: string;
  riskBand?: StaffBurnoutRiskBand | string;
  reviewerDecision?: StaffBurnoutDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.staffUid) query.staff_uid = params.staffUid;
  if (params.department) query.department = params.department;
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.reviewerDecision) query.reviewer_decision = params.reviewerDecision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ reviews: StaffBurnoutReview[]; count: number }>(
    '/admin/clinical-ai/staff-burnout/reviews',
    query
  );
}

export async function evaluateStaffBurnout(payload: { staffUid: string; windowDays?: number }) {
  const body: Record<string, unknown> = { staff_uid: payload.staffUid };
  if (payload.windowDays) body.window_days = payload.windowDays;
  return postJSON<{
    review_id: number | null;
    generation_id: number | null;
    draft: {
      risk_score: number;
      risk_band: StaffBurnoutRiskBand;
      contributing_signals: StaffBurnoutSignal[];
      recommended_actions: string[];
      total_hours: number;
      overtime_hours: number;
      consecutive_night_shifts: number;
    };
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    review_status: string;
    rules_authoritative: boolean;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/staff-burnout/evaluate', body);
}

export async function decideStaffBurnoutReview(
  id: number,
  decision: Exclude<StaffBurnoutDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<StaffBurnoutReview>(`/admin/clinical-ai/staff-burnout/reviews/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Pediatric dosing safety
// ---------------------------------------------------------------------------
export type PediatricSafetyBand = 'safe' | 'caution' | 'unsafe' | 'missing_data' | 'unknown';
export type PediatricDoseDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'edited';
export type PediatricAgeBand = 'neonate' | 'infant' | 'toddler' | 'child' | 'adolescent' | 'adult' | 'unknown';

export interface PediatricDoseCheck {
  id: number;
  tenant_id?: string;
  prescription_id: number | null;
  patient_uid: string;
  patient_name?: string | null;
  admission_id: number | null;
  generation_id: number | null;
  age_days: number | null;
  weight_kg: number | null;
  age_band: PediatricAgeBand;
  medication_name: string;
  prescribed_dose_mg: number | null;
  prescribed_route: string | null;
  prescribed_frequency: string | null;
  max_dose_per_kg_mg: number | null;
  absolute_max_dose_mg: number | null;
  calculated_max_dose_mg: number | null;
  variance_pct: number | null;
  safety_band: PediatricSafetyBand;
  rationale: string | null;
  suggested_actions: string[];
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: PediatricDoseDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listPediatricDoseChecks(params: {
  patientUid?: string;
  admissionId?: number | string;
  safetyBand?: PediatricSafetyBand | string;
  reviewerDecision?: PediatricDoseDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.safetyBand) query.safety_band = params.safetyBand;
  if (params.reviewerDecision) query.reviewer_decision = params.reviewerDecision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ checks: PediatricDoseCheck[]; count: number }>(
    '/admin/clinical-ai/pediatric-dose-checks',
    query
  );
}

export async function evaluatePediatricDose(payload: {
  patientUid: string;
  medicationName: string;
  prescribedDoseMg: number;
  prescriptionId?: number;
  admissionId?: number;
  prescribedRoute?: string;
  prescribedFrequency?: string;
  ageDaysOverride?: number;
  weightKgOverride?: number;
}) {
  const body: Record<string, unknown> = {
    patient_uid: payload.patientUid,
    medication_name: payload.medicationName,
    prescribed_dose_mg: payload.prescribedDoseMg,
  };
  if (payload.prescriptionId) body.prescription_id = payload.prescriptionId;
  if (payload.admissionId) body.admission_id = payload.admissionId;
  if (payload.prescribedRoute) body.prescribed_route = payload.prescribedRoute;
  if (payload.prescribedFrequency) body.prescribed_frequency = payload.prescribedFrequency;
  if (payload.ageDaysOverride !== undefined) body.age_days_override = payload.ageDaysOverride;
  if (payload.weightKgOverride !== undefined) body.weight_kg_override = payload.weightKgOverride;
  return postJSON<{
    check_id: number | null;
    generation_id: number | null;
    safety_band: PediatricSafetyBand;
    calculated_max_dose_mg: number | null;
    variance_pct: number | null;
    age_band: PediatricAgeBand;
    medication_name: string;
    draft: Record<string, unknown>;
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    review_status: string;
    rules_authoritative: boolean;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/pediatric-dose-checks/evaluate', body);
}

export async function decidePediatricDoseCheck(
  id: number,
  decision: Exclude<PediatricDoseDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<PediatricDoseCheck>(`/admin/clinical-ai/pediatric-dose-checks/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Lab autoverification / delta check
// ---------------------------------------------------------------------------
export type LabAutoverificationDecision = 'pending' | 'auto_verify' | 'hold_for_review' | 'critical' | 'rejected';
export type LabAutoverificationReviewerDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'edited';
export type LabCriticalBand =
  | 'normal'
  | 'borderline_low'
  | 'borderline_high'
  | 'critical_low'
  | 'critical_high'
  | 'unknown';

export interface LabAutoverification {
  id: number;
  tenant_id?: string;
  investigation_id: number | null;
  patient_uid: string;
  patient_name?: string | null;
  generation_id: number | null;
  test_name: string;
  result_value: number | null;
  result_text: string | null;
  units: string | null;
  prior_value: number | null;
  prior_recorded_at: string | null;
  delta_pct: number | null;
  reference_low: number | null;
  reference_high: number | null;
  critical_low: number | null;
  critical_high: number | null;
  critical_band: LabCriticalBand;
  decision: LabAutoverificationDecision;
  decision_reason: string | null;
  suggested_actions: string[];
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: LabAutoverificationReviewerDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listLabAutoverifications(params: {
  patientUid?: string;
  decision?: LabAutoverificationDecision | string;
  criticalBand?: LabCriticalBand | string;
  reviewerDecision?: LabAutoverificationReviewerDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.criticalBand) query.critical_band = params.criticalBand;
  if (params.reviewerDecision) query.reviewer_decision = params.reviewerDecision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ autoverifications: LabAutoverification[]; count: number }>(
    '/admin/clinical-ai/lab-autoverifications',
    query
  );
}

export async function evaluateLabAutoverification(investigationId: number) {
  return postJSON<{
    review_id: number | null;
    generation_id: number | null;
    draft: {
      decision: LabAutoverificationDecision;
      critical_band: LabCriticalBand;
      test_name: string;
      result_value: number | null;
      units: string | null;
      prior_value: number | null;
      delta_pct: number | null;
      decision_reason: string | null;
      suggested_actions: string[];
    };
    decision: LabAutoverificationDecision;
    critical_band: LabCriticalBand;
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    review_status: string;
    rules_authoritative: boolean;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/lab-autoverifications/evaluate', { investigation_id: investigationId });
}

export async function decideLabAutoverification(
  id: number,
  decision: Exclude<LabAutoverificationReviewerDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<LabAutoverification>(`/admin/clinical-ai/lab-autoverifications/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Payer contract variance / underpayment AI
// ---------------------------------------------------------------------------
export type PayerVarianceDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'escalated';
export type PayerVarianceCategory =
  | 'match'
  | 'underpayment'
  | 'overpayment'
  | 'missing_contract'
  | 'missing_payment'
  | 'unknown';
export type PayerVarianceBand = 'within_tolerance' | 'review' | 'investigate' | 'escalate' | 'unknown';

export interface PayerContract {
  id: number;
  tenant_id?: string;
  payer_name: string;
  payer_code: string | null;
  procedure_code: string;
  procedure_description: string | null;
  expected_rate_minor: number;
  currency_code: string;
  tolerance_pct: number;
  effective_start_date: string;
  effective_end_date: string | null;
  contract_reference: string | null;
  notes: string | null;
  active: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface PayerVarianceReview {
  id: number;
  tenant_id?: string;
  claim_id: number;
  claim_number?: string | null;
  contract_id: number | null;
  patient_uid: string | null;
  patient_name?: string | null;
  generation_id: number | null;
  payer_name: string;
  procedure_code: string | null;
  expected_amount_minor: number;
  paid_amount_minor: number;
  claim_amount_minor: number;
  variance_minor: number;
  variance_pct: number;
  variance_category: PayerVarianceCategory;
  variance_band: PayerVarianceBand;
  reason: string | null;
  suggested_actions: string[];
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: PayerVarianceDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listPayerContracts(params: {
  payerName?: string;
  procedureCode?: string;
  active?: boolean;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.payerName) query.payer_name = params.payerName;
  if (params.procedureCode) query.procedure_code = params.procedureCode;
  if (typeof params.active === 'boolean') query.active = String(params.active);
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ contracts: PayerContract[]; count: number }>(
    '/admin/clinical-ai/payer-contracts',
    query
  );
}

export async function upsertPayerContract(payload: {
  payerName: string;
  procedureCode: string;
  expectedRateMinor: number;
  payerCode?: string;
  procedureDescription?: string;
  currencyCode?: string;
  tolerancePct?: number;
  effectiveStartDate?: string;
  effectiveEndDate?: string;
  contractReference?: string;
  notes?: string;
  active?: boolean;
}) {
  const body: Record<string, unknown> = {
    payer_name: payload.payerName,
    procedure_code: payload.procedureCode,
    expected_rate_minor: payload.expectedRateMinor,
  };
  if (payload.payerCode) body.payer_code = payload.payerCode;
  if (payload.procedureDescription) body.procedure_description = payload.procedureDescription;
  if (payload.currencyCode) body.currency_code = payload.currencyCode;
  if (payload.tolerancePct !== undefined) body.tolerance_pct = payload.tolerancePct;
  if (payload.effectiveStartDate) body.effective_start_date = payload.effectiveStartDate;
  if (payload.effectiveEndDate) body.effective_end_date = payload.effectiveEndDate;
  if (payload.contractReference) body.contract_reference = payload.contractReference;
  if (payload.notes) body.notes = payload.notes;
  if (typeof payload.active === 'boolean') body.active = payload.active;
  return postJSON<PayerContract>('/admin/clinical-ai/payer-contracts', body);
}

export async function listPayerVarianceReviews(params: {
  claimId?: number | string;
  decision?: PayerVarianceDecision | string;
  category?: PayerVarianceCategory | string;
  band?: PayerVarianceBand | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.claimId) query.claim_id = String(params.claimId);
  if (params.decision) query.decision = params.decision;
  if (params.category) query.category = params.category;
  if (params.band) query.band = params.band;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ reviews: PayerVarianceReview[]; count: number }>(
    '/admin/clinical-ai/payer-variance/reviews',
    query
  );
}

export async function evaluateClaimVariance(payload: {
  claimId: number;
  procedureCode?: string;
  tolerancePct?: number;
}) {
  const body: Record<string, unknown> = { claim_id: payload.claimId };
  if (payload.procedureCode) body.procedure_code = payload.procedureCode;
  if (payload.tolerancePct !== undefined) body.tolerance_pct = payload.tolerancePct;
  return postJSON<{
    review_id: number | null;
    generation_id: number | null;
    draft: {
      claim: Record<string, unknown>;
      contract: Record<string, unknown> | null;
      variance_category: PayerVarianceCategory;
      variance_band: PayerVarianceBand;
      expected_amount_minor: number;
      paid_amount_minor: number;
      claim_amount_minor: number;
      variance_minor: number;
      variance_pct: number;
      reason: string;
      suggested_actions: string[];
    };
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    review_status: string;
    rules_authoritative: boolean;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/payer-variance/evaluate', body);
}

export async function decidePayerVarianceReview(
  id: number,
  decision: Exclude<PayerVarianceDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<PayerVarianceReview>(`/admin/clinical-ai/payer-variance/reviews/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Consent-aware family update generator
// ---------------------------------------------------------------------------
export type FamilyUpdateDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'edited';
export type FamilyUpdateStatus = 'draft' | 'ready_to_send' | 'sent' | 'withdrawn';
export type FamilyCaregiverRelationship =
  | 'spouse'
  | 'parent'
  | 'child'
  | 'sibling'
  | 'friend'
  | 'legal_guardian'
  | 'guardian'
  | 'care_manager'
  | 'other';
export type FamilyUpdateLanguage = 'en' | 'hi' | 'ta' | 'te' | 'ml' | 'mr' | 'bn' | 'kn';

export interface FamilyUpdateDraft {
  language: FamilyUpdateLanguage;
  caregiver_identifier: string | null;
  caregiver_relationship: FamilyCaregiverRelationship;
  consent_scope: string[];
  plain_language_summary: string;
  current_status: string;
  next_steps: string;
  when_to_worry: string;
  questions_you_may_have: string[];
  summary?: string;
}

export interface FamilyUpdate {
  id: number;
  tenant_id?: string;
  patient_uid: string;
  patient_name?: string | null;
  admission_id: number | null;
  caregiver_identifier: string | null;
  caregiver_relationship: FamilyCaregiverRelationship;
  consent_reference: string | null;
  consent_scope: string[];
  language: FamilyUpdateLanguage;
  generation_id: number | null;
  source_generation_id: number | null;
  update_draft: FamilyUpdateDraft;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  update_status: FamilyUpdateStatus;
  reviewer_decision: FamilyUpdateDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  sent_at?: string | null;
  sent_by?: string | null;
  delivery_channel?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listFamilyUpdates(params: {
  admissionId?: number | string;
  patientUid?: string;
  updateStatus?: FamilyUpdateStatus | string;
  decision?: FamilyUpdateDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.updateStatus) query.update_status = params.updateStatus;
  if (params.decision) query.decision = params.decision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ updates: FamilyUpdate[]; count: number }>(
    '/admin/clinical-ai/family-updates',
    query
  );
}

export async function generateFamilyUpdate(payload: {
  patientUid: string;
  admissionId?: number;
  caregiverIdentifier?: string;
  caregiverRelationship?: FamilyCaregiverRelationship;
  language?: FamilyUpdateLanguage;
  sourceGenerationId?: number;
  consentReference?: string;
}) {
  const body: Record<string, unknown> = { patient_uid: payload.patientUid };
  if (payload.admissionId) body.admission_id = payload.admissionId;
  if (payload.caregiverIdentifier) body.caregiver_identifier = payload.caregiverIdentifier;
  if (payload.caregiverRelationship) body.caregiver_relationship = payload.caregiverRelationship;
  if (payload.language) body.language = payload.language;
  if (payload.sourceGenerationId) body.source_generation_id = payload.sourceGenerationId;
  if (payload.consentReference) body.consent_reference = payload.consentReference;
  return postJSON<{
    update_id: number | null;
    generation_id: number | null;
    draft: FamilyUpdateDraft;
    consent_scope: string[];
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    prompt_version: string;
    update_status: FamilyUpdateStatus | string;
    review_status: string;
    requires_signoff: boolean;
    rules_authoritative: boolean;
    decision_support_only: boolean;
    language: FamilyUpdateLanguage;
    caregiver_relationship: FamilyCaregiverRelationship;
  }>('/admin/clinical-ai/family-updates', body);
}

export async function decideFamilyUpdate(
  id: number,
  decision: Exclude<FamilyUpdateDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<FamilyUpdate>(`/admin/clinical-ai/family-updates/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

export async function markFamilyUpdateSent(id: number, deliveryChannel?: string) {
  return postJSON<FamilyUpdate>(`/admin/clinical-ai/family-updates/${id}/sent`, {
    delivery_channel: deliveryChannel,
  });
}

// ---------------------------------------------------------------------------
// Nursing ambient documentation
// ---------------------------------------------------------------------------
export type NursingAmbientShift = 'day' | 'evening' | 'night' | 'custom';
export type NursingAmbientDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'edited';

export interface NursingAmbientObservation {
  description: string;
  speaker: string;
  start_seconds: number;
  citation?: ClinicalAiSourceCitation | null;
  segment_index: number;
  severity?: string;
}

export interface NursingAmbientIntakeOutputEntry extends NursingAmbientObservation {
  intake_ml?: number | null;
  output_ml?: number | null;
}

export interface NursingAmbientIntakeOutput {
  entries: NursingAmbientIntakeOutputEntry[];
  total_intake_ml: number;
  total_output_ml: number;
  balance_ml: number;
}

export interface NursingAmbientDraft {
  shift: NursingAmbientShift;
  shift_summary: string;
  patient_reported: string;
  wounds: NursingAmbientObservation[];
  drains: NursingAmbientObservation[];
  iv_lines: NursingAmbientObservation[];
  intake_output: NursingAmbientIntakeOutput;
  mobility: NursingAmbientObservation[];
  falls: NursingAmbientObservation[];
  handover_notes: NursingAmbientObservation[];
  patient_education: NursingAmbientObservation[];
  summary?: string;
  speaker_talk_time?: Record<string, number>;
}

export interface NursingAmbientSession {
  id: number;
  tenant_id?: string;
  patient_uid: string;
  patient_name?: string | null;
  admission_id: number | null;
  nurse_uid?: string | null;
  shift: NursingAmbientShift;
  recording_started_at: string;
  recording_ended_at?: string | null;
  duration_seconds?: number | null;
  speaker_count: number;
  transcript_status: string;
  nursing_note_draft: NursingAmbientDraft;
  generation_id: number | null;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: NursingAmbientDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listNursingAmbientSessions(params: {
  admissionId?: number | string;
  patientUid?: string;
  shift?: NursingAmbientShift | string;
  decision?: NursingAmbientDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.shift) query.shift = params.shift;
  if (params.decision) query.decision = params.decision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ sessions: NursingAmbientSession[]; count: number }>(
    '/admin/clinical-ai/nursing-ambient/sessions',
    query
  );
}

export async function generateNursingAmbientSession(payload: {
  patientUid: string;
  admissionId?: number;
  shift?: NursingAmbientShift;
  recordingStartedAt?: string;
  transcriptSegments?: Array<{ speaker: string; text: string; start_seconds?: number; end_seconds?: number }>;
  consentReference?: string;
}) {
  const body: Record<string, unknown> = {
    patient_uid: payload.patientUid,
    transcript_segments: payload.transcriptSegments || [],
  };
  if (payload.admissionId) body.admission_id = payload.admissionId;
  if (payload.shift) body.shift = payload.shift;
  if (payload.recordingStartedAt) body.recording_started_at = payload.recordingStartedAt;
  if (payload.consentReference) body.consent_reference = payload.consentReference;
  return postJSON<{
    session_id: number | null;
    generation_id: number | null;
    draft: NursingAmbientDraft;
    module_key: string;
    prompt_version: string;
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    session_status: string;
    review_status: string;
    requires_signoff: boolean;
    rules_authoritative: boolean;
    decision_support_only: boolean;
    shift: NursingAmbientShift;
  }>('/admin/clinical-ai/nursing-ambient/sessions', body);
}

export async function decideNursingAmbientSession(
  id: number,
  decision: Exclude<NursingAmbientDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<NursingAmbientSession>(`/admin/clinical-ai/nursing-ambient/sessions/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Appeal letter generator for denied claims
// ---------------------------------------------------------------------------
export type AppealLetterDecision = 'pending' | 'accepted' | 'deferred' | 'rejected' | 'edited';
export type AppealLetterStatus =
  | 'draft'
  | 'ready_for_submission'
  | 'submitted'
  | 'approved'
  | 'denied'
  | 'withdrawn';
export type AppealType = 'first_level' | 'second_level' | 'external_review' | 'reconsideration';
export type AppealDenialClassification =
  | 'medical_necessity'
  | 'coding_error'
  | 'prior_auth_missing'
  | 'documentation_insufficient'
  | 'duplicate_claim'
  | 'coverage'
  | 'timely_filing'
  | 'bundled_service'
  | 'non_covered_service'
  | 'other';

export interface AppealLetterDraft {
  cover_letter: string;
  medical_necessity: string;
  clinical_evidence: Record<string, unknown>;
  supporting_documentation: string[];
  requested_action: string;
  procedure_codes: string[];
  diagnosis_codes: string[];
  appeal_type: AppealType;
  classification: AppealDenialClassification;
  summary?: string;
}

export interface AppealLetter {
  id: number;
  tenant_id?: string;
  claim_id: number;
  claim_number?: string | null;
  insurance_provider?: string | null;
  patient_uid: string;
  patient_name?: string | null;
  admission_id: number | null;
  generation_id: number | null;
  denial_reason: string | null;
  denial_code: string | null;
  denial_classification: AppealDenialClassification;
  appeal_type: AppealType;
  letter_draft: AppealLetterDraft;
  clinical_evidence: Record<string, unknown>;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  appeal_status: AppealLetterStatus;
  reviewer_decision: AppealLetterDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  submitted_at?: string | null;
  submitted_by?: string | null;
  payer_reference_id?: string | null;
  payer_response?: Record<string, unknown> | null;
  payer_response_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listAppealLetters(params: {
  claimId?: number | string;
  patientUid?: string;
  appealStatus?: AppealLetterStatus | string;
  decision?: AppealLetterDecision | string;
  classification?: AppealDenialClassification | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.claimId) query.claim_id = String(params.claimId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.appealStatus) query.appeal_status = params.appealStatus;
  if (params.decision) query.decision = params.decision;
  if (params.classification) query.classification = params.classification;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ appeals: AppealLetter[]; count: number }>('/admin/clinical-ai/appeal-letters', query);
}

export async function generateAppealLetter(payload: {
  claimId: number;
  denialReason?: string;
  denialCode?: string;
  appealType?: AppealType;
  admissionId?: number;
}) {
  const body: Record<string, unknown> = { claim_id: payload.claimId };
  if (payload.denialReason) body.denial_reason = payload.denialReason;
  if (payload.denialCode) body.denial_code = payload.denialCode;
  if (payload.appealType) body.appeal_type = payload.appealType;
  if (payload.admissionId) body.admission_id = payload.admissionId;
  return postJSON<{
    appeal_id: number | null;
    generation_id: number | null;
    draft: AppealLetterDraft;
    claim: {
      id: number;
      claim_number: string;
      insurance_provider: string;
      policy_number: string | null;
      claim_amount: number | string;
      status: string;
    };
    classification: { classification: AppealDenialClassification; severity: string };
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    module_key: string;
    prompt_version: string;
    appeal_status: AppealLetterStatus;
    review_status: string;
    rules_authoritative: boolean;
    decision_support_only: boolean;
    ai_metadata?: Record<string, unknown>;
  }>('/admin/clinical-ai/appeal-letters', body);
}

export async function decideAppealLetter(
  id: number,
  decision: Exclude<AppealLetterDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<AppealLetter>(`/admin/clinical-ai/appeal-letters/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

export async function submitAppealLetter(id: number, payerReferenceId?: string) {
  return postJSON<AppealLetter>(`/admin/clinical-ai/appeal-letters/${id}/submit`, {
    payer_reference_id: payerReferenceId,
  });
}

export async function recordAppealPayerResponse(
  id: number,
  status: 'approved' | 'denied' | 'withdrawn',
  payload?: { response?: Record<string, unknown>; note?: string }
) {
  return postJSON<AppealLetter>(`/admin/clinical-ai/appeal-letters/${id}/payer-response`, {
    status,
    response: payload?.response,
    note: payload?.note,
  });
}

// ---------------------------------------------------------------------------
// Patient teach-back / comprehension AI
// ---------------------------------------------------------------------------
export type TeachBackDecision = 'pending' | 'accepted' | 'deferred' | 'rejected';
export type TeachBackStatus = 'draft' | 'in_progress' | 'completed' | 'needs_clinician_review';
export type TeachBackLanguage = 'en' | 'hi' | 'ta' | 'te' | 'ml' | 'mr' | 'bn' | 'kn';
export type TeachBackCategory =
  | 'medications'
  | 'warning_signs'
  | 'follow_up'
  | 'diet_activity'
  | 'wound_care'
  | 'emergency_escalation';

export interface TeachBackQuestion {
  id: string;
  category: TeachBackCategory;
  prompt: string;
  expected: string;
  expected_keywords?: string[];
  choices?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
  free_text?: boolean;
  explanation?: string;
  source_citation?: ClinicalAiSourceCitation | null;
}

export interface TeachBackAnswer {
  question_id: string;
  answer?: string;
  uncertain?: boolean;
}

export interface TeachBackMisunderstandingFlag {
  question_id: string;
  category: TeachBackCategory;
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  code: string;
  prompt: string;
  expected?: string;
  patient_answer?: string;
  message: string;
  source_citation?: ClinicalAiSourceCitation | null;
}

export interface TeachBackSession {
  id: number;
  tenant_id?: string;
  patient_uid: string | null;
  patient_name?: string | null;
  admission_id: number | null;
  generation_id: number | null;
  source_generation_id: number | null;
  language: TeachBackLanguage;
  status: TeachBackStatus;
  questions: TeachBackQuestion[];
  patient_answers: TeachBackAnswer[];
  misunderstanding_flags: TeachBackMisunderstandingFlag[];
  comprehension_score: number;
  source_citations: ClinicalAiSourceCitation[];
  safety_flags: ClinicalAiSafetyFlagSummary[];
  reviewer_decision: TeachBackDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listTeachBackSessions(params: {
  admissionId?: number | string;
  patientUid?: string;
  status?: TeachBackStatus | string;
  decision?: TeachBackDecision | string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.status) query.status = params.status;
  if (params.decision) query.decision = params.decision;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ sessions: TeachBackSession[]; count: number }>(
    '/admin/clinical-ai/teach-back/sessions',
    query
  );
}

export async function generateTeachBackSession(payload: {
  admissionId?: number;
  patientUid?: string;
  sourceGenerationId?: number;
  language?: TeachBackLanguage;
}) {
  const body: Record<string, unknown> = {};
  if (payload.admissionId) body.admission_id = payload.admissionId;
  if (payload.patientUid) body.patient_uid = payload.patientUid;
  if (payload.sourceGenerationId) body.source_generation_id = payload.sourceGenerationId;
  if (payload.language) body.language = payload.language;
  return postJSON<{
    session_id: number | null;
    generation_id: number | null;
    clinical_review_id: number | null;
    draft: {
      questions: TeachBackQuestion[];
      patient_answers: TeachBackAnswer[];
      misunderstanding_flags: TeachBackMisunderstandingFlag[];
      comprehension_score: number;
      status: TeachBackStatus;
      summary?: string;
      coverage?: Record<TeachBackCategory, boolean>;
    };
    module_key: string;
    prompt_version: string;
    source_citations: ClinicalAiSourceCitation[];
    safety_flags: ClinicalAiSafetyFlagSummary[];
    session_status: TeachBackStatus | string;
    review_status: string;
    requires_signoff: boolean;
    rules_authoritative: boolean;
    language: TeachBackLanguage;
    ai_metadata?: Record<string, unknown>;
  }>('/admin/clinical-ai/teach-back/sessions', body);
}

export async function submitTeachBackAnswers(id: number, answers: TeachBackAnswer[]) {
  return postJSON<TeachBackSession & { evaluated_answers: unknown[] }>(
    `/admin/clinical-ai/teach-back/sessions/${id}/answers`,
    { answers }
  );
}

export async function decideTeachBackSession(
  id: number,
  decision: Exclude<TeachBackDecision, 'pending'>,
  note?: string
) {
  return fetchAdminAPI<TeachBackSession>(`/admin/clinical-ai/teach-back/sessions/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Sepsis bundle sentinel
// ---------------------------------------------------------------------------
export type SepsisBundleRiskBand = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
export type SepsisBundleDecision = 'pending' | 'acknowledged' | 'escalated' | 'dismissed';

export interface SepsisBundleFinding {
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  code: string;
  category: string;
  title: string;
  recommendation: string;
  evidence?: Array<Record<string, unknown>>;
}

export interface SepsisBundleAudit {
  id: number;
  tenant_id?: string;
  admission_id: number;
  patient_uid: string | null;
  patient_name?: string | null;
  generation_id: number | null;
  risk_score: number;
  risk_band: SepsisBundleRiskBand;
  criteria: SepsisBundleFinding[];
  bundle_gaps: SepsisBundleFinding[];
  recommendations: Array<{ code: string; severity: string; recommendation: string }>;
  source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
  safety_flags: Array<{ severity: string; code: string; message: string }>;
  reviewer_decision: SepsisBundleDecision;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reviewer_note?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export async function listSepsisBundleAudits(params: {
  admissionId?: number | string;
  patientUid?: string;
  decision?: string;
  riskBand?: string;
  limit?: number;
} = {}) {
  const query: Record<string, string> = {};
  if (params.admissionId) query.admission_id = String(params.admissionId);
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.decision) query.decision = params.decision;
  if (params.riskBand) query.risk_band = params.riskBand;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ audits: SepsisBundleAudit[]; count: number }>(
    '/admin/clinical-ai/sepsis-bundle/audits',
    query
  );
}

export async function generateSepsisBundleAudit(admissionId: number) {
  return postJSON<{
    audit_id: number | null;
    generation_id: number | null;
    review_id: number | null;
    draft: {
      risk_score: number;
      risk_band: SepsisBundleRiskBand;
      criteria: SepsisBundleFinding[];
      bundle_gaps: SepsisBundleFinding[];
      recommendations: Array<{ code: string; severity: string; recommendation: string }>;
      summary?: string;
      suspected_sepsis?: boolean;
      shock_signal?: boolean;
    };
    module_key: string;
    prompt_version: string;
    source_citations: Array<{ source_type: string; source_id: string | null; label: string; timestamp?: string | null }>;
    safety_flags: Array<{ severity: string; code: string; message: string }>;
    review_status: string;
    requires_signoff: boolean;
  }>('/admin/clinical-ai/sepsis-bundle/audits', { admission_id: admissionId });
}

export async function decideSepsisBundleAudit(id: number, decision: Exclude<SepsisBundleDecision, 'pending'>, note?: string) {
  return fetchAdminAPI<SepsisBundleAudit>(`/admin/clinical-ai/sepsis-bundle/audits/${id}`, {
    method: 'PATCH',
    body: { decision, note },
  });
}

// ---------------------------------------------------------------------------
// Ambient clinical documentation
// ---------------------------------------------------------------------------
export interface AmbientEncounter {
  id: number;
  tenant_id?: string;
  patient_uid: string;
  admission_id: number | null;
  recording_started_at: string;
  recording_ended_at: string | null;
  duration_seconds: number | null;
  clinician_uid: string | null;
  recorded_by: string | null;
  stt_provider: string;
  stt_language: string | null;
  diarization_provider: string | null;
  speaker_count: number;
  transcript_status: 'completed' | 'skipped' | 'pending' | string;
  generation_id: number | null;
  created_at: string;
}

export async function listAmbientEncounters(params: { patientUid?: string; limit?: number } = {}) {
  const query: Record<string, string> = {};
  if (params.patientUid) query.patient_uid = params.patientUid;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ encounters: AmbientEncounter[]; count: number }>(
    '/clinical/ambient/encounters',
    query
  );
}

// ---------------------------------------------------------------------------
// Staff roster optimizer
// ---------------------------------------------------------------------------
export interface RosterAssignment {
  date: string;
  shift_code: 'morning' | 'evening' | 'night' | string;
  start_hour: number;
  end_hour: number;
  staff_uid: string;
  staff_name: string | null;
  preferred: boolean;
}

export interface RosterCoverageGap {
  date: string;
  shift_code: string;
  needed: number;
  filled: number;
  shortfall: number;
  reasons_sample?: Array<{ staff_uid?: string; reason: string }>;
}

export interface RosterPreferenceConflict {
  staff_uid: string;
  staff_name: string | null;
  date: string;
  shift_code: string;
  preferred: string[];
  message: string;
}

export interface RosterRun {
  id: number;
  department: string;
  start_date: string;
  end_date: string;
  status: 'suggested' | 'edited' | 'published' | 'discarded' | string;
  total_slots: number;
  filled_slots: number;
  coverage_gap_count: number;
  preference_conflict_count: number;
  published_at: string | null;
  created_at: string;
}

export interface RosterSuggestion {
  run_id: number | null;
  department: string;
  start_date: string;
  end_date: string;
  assignments: RosterAssignment[];
  coverage_gaps: RosterCoverageGap[];
  preference_conflicts: RosterPreferenceConflict[];
  total_slots: number;
  filled_slots: number;
  staff_pool_size: number;
  module_key: string;
  status?: string;
  decision_support_only: boolean;
}

export async function listRosterRuns(params: { department?: string; status?: string; limit?: number } = {}) {
  const query: Record<string, string> = {};
  if (params.department) query.department = params.department;
  if (params.status) query.status = params.status;
  if (params.limit) query.limit = String(params.limit);
  return getJSON<{ runs: RosterRun[]; count: number }>(
    '/admin/clinical-ai/roster',
    query
  );
}

export async function generateRosterSuggestion(payload: {
  department: string;
  start_date: string;
  end_date: string;
}) {
  return postJSON<RosterSuggestion>('/admin/clinical-ai/roster', payload);
}

export async function publishRosterRun(id: number) {
  return fetchAdminAPI<{ id: number; status: string; published_at: string; published_by: string | null }>(
    `/admin/clinical-ai/roster/${id}/publish`,
    {
      method: 'PATCH',
      body: {},
    }
  );
}

export async function discardRosterRun(id: number) {
  return fetchAdminAPI<{ id: number; status: string }>(
    `/admin/clinical-ai/roster/${id}/discard`,
    {
      method: 'PATCH',
      body: {},
    }
  );
}
