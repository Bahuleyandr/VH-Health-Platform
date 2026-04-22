import { deleteJSON, fetchAdminAPI, getJSON, postJSON, putJSON } from './core';

// Types
export interface Admission {
  id: number;
  encounter_id: string;
  patient_uid: string;
  patient_name?: string;
  admitting_doctor: string;
  department?: string;
  ward?: string;
  bed_number?: string;
  chief_complaint: string;
  admitting_diagnosis?: string;
  status: 'admitted' | 'transferred' | 'discharged' | 'lama' | 'expired';
  priority: 'routine' | 'urgent' | 'emergent';
  code_status: string;
  admitted_at: string;
  discharged_at?: string;
  actual_los_days?: number;
}

export interface ClinicalNote {
  id: number;
  patient_uid: string;
  author_uid: string;
  author_name?: string;
  note_type: 'soap' | 'progress' | 'procedure' | 'discharge' | 'nursing_assessment';
  content: Record<string, unknown>;
  is_signed: boolean;
  created_at: string;
}

export interface ClinicalOrder {
  id: number;
  order_number: string;
  patient_uid: string;
  order_type: 'medication' | 'investigation' | 'nursing' | 'diet' | 'activity';
  priority: string;
  status: string;
  details: Record<string, unknown>;
  ordered_by: string;
  created_at: string;
}

export interface AdmissionStats {
  totalActive: number;
  avgLOS: number;
  occupancyRate: number;
  dischargeBreakdown: Record<string, number>;
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

export interface ClinicalAiAuditLog {
  id: number;
  uid?: string | null;
  role?: string | null;
  action: string;
  resource?: string | null;
  resource_id?: string | null;
  metadata?: {
    changed_fields?: string[];
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

// API functions
export async function getActiveAdmissions(params?: { page?: number; limit?: number; ward?: string; status?: string }) {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.ward) query.set('ward', params.ward);
  if (params?.status) query.set('status', params.status);
  return getJSON(`/emr/admissions?${query}`);
}

export async function getAdmissionDetail(id: number) { return getJSON(`/emr/admission/${id}`); }
export async function getAdmissionStats(dateFrom: string, dateTo: string) { return getJSON(`/emr/admissions/stats?date_from=${dateFrom}&date_to=${dateTo}`); }
export async function getPatientTimeline(uid: string) { return getJSON(`/emr/timeline/${uid}`); }
export async function getPatientNotes(uid: string) { return getJSON(`/emr/notes/patient/${uid}`); }
export async function getPatientOrders(uid: string) { return getJSON(`/emr/orders/patient/${uid}`); }
export async function getActiveProblemList(uid: string) { return getJSON(`/emr/diagnosis/patient/${uid}`); }
export async function getActiveAlerts(uid: string) { return getJSON(`/emr/cds/alerts/${uid}`); }
export async function searchICD10(query: string) { return getJSON(`/emr/icd10/search?q=${encodeURIComponent(query)}`); }
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

// Discharge Summary
export interface DischargeSummary {
  hospital_course: string;
  discharge_diagnosis: string;
  discharge_condition: string;
  medications_on_discharge: Array<{ name: string; dose: string; route: string; frequency: string; duration: string }>;
  follow_up_instructions: string;
  activity_restrictions: string;
  diet_instructions: string;
  warning_signs: string;
  procedures_performed: string[];
  investigations_summary: Array<{ test: string; status: string; result: string }>;
  generated_at: string;
  is_draft: boolean;
  is_signed: boolean;
  signed_by: string | null;
  signed_at: string | null;
}

export async function generateDischargeSummary(admissionId: number) {
  return postJSON(`/emr/${admissionId}/discharge-summary/generate`, {});
}
export async function saveDischargeSummary(admissionId: number, summary: Partial<DischargeSummary>) {
  return putJSON(`/emr/${admissionId}/discharge-summary`, { discharge_summary: summary });
}
export async function signDischargeSummary(admissionId: number) {
  return postJSON(`/emr/${admissionId}/discharge-summary/sign`, {});
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
}

export interface CanaryCasePayload {
  module_key: string;
  label: string;
  input_packet: Record<string, unknown>;
  expected_keys?: string[];
  expected_citations_min?: number;
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
  return postJSON<{
    intake_id: number | null;
    generation_id: number | null;
    extraction_status: string;
    safety_flags: Array<{ severity: string; code: string; message: string }>;
    used_ai: boolean;
    provider: string;
    module_key: string;
    decision_support_only: boolean;
  }>('/admin/clinical-ai/documents/intake', payload);
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
