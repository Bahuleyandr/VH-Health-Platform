import { fetchAdminAPI, getJSON, postJSON, putJSON } from './core';

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
export async function updateClinicalAiModule(moduleKey: string, payload: Partial<ClinicalAiModule>) {
  return fetchAdminAPI<ClinicalAiModule>(`/admin/clinical-ai/modules/${encodeURIComponent(moduleKey)}`, {
    method: 'PATCH',
    body: payload,
  });
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

// ---------------------------------------------------------------------------
// Operational AI: charge capture (no-show + OT predictions are per-entity, not listed here)
// ---------------------------------------------------------------------------
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

export async function listTrialMatches(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ matches: TrialMatch[]; count: number }>(
    '/admin/clinical-ai/trials/matches',
    query
  );
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

export async function listRcaDrafts(decision?: string) {
  const query: Record<string, string> = {};
  if (decision) query.decision = decision;
  return getJSON<{ drafts: RcaDraftSummary[]; count: number }>(
    '/admin/clinical-ai/rca',
    query
  );
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
  submitted_at: string | null;
  payer_decided_at: string | null;
  payer_decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

export async function listPriorAuthorizations(status?: string) {
  const query: Record<string, string> = {};
  if (status) query.status = status;
  return getJSON<{ prior_auths: PriorAuthRequest[]; count: number }>(
    '/admin/clinical-ai/prior-auth',
    query
  );
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
