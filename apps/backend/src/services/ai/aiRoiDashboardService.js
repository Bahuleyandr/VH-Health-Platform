/**
 * AI ROI Dashboard.
 *
 * Computes realized ROI metrics across clinical AI modules: time saved per
 * accepted draft, documentation hours saved, denial value prevented via
 * appeal/prior-auth approvals, and cost per useful draft. Aggregates from
 * clinical_ai_generations, clinical_ai_reviews, module-specific review
 * tables, and insurance claim lifecycle tables.
 *
 * Read-only. Never alters clinical decisions, billing, or orders.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

const MODULE_KEY = 'ai_roi_dashboard';

const DEFAULT_MODULE_TIME_SAVED_MIN = {
  discharge_summary: 18,
  handover_summary: 10,
  patient_record_summary: 12,
  clinical_task_extractor: 8,
  daily_ward_round_brief: 15,
  patient_aftercare_instructions: 15,
  medication_reconciliation: 12,
  antimicrobial_stewardship: 10,
  discharge_readiness: 8,
  abnormal_result_triage: 6,
  referral_letter: 15,
  clinical_coding_assist: 7,
  ai_safety_reviewer: 2,
  denial_risk_assist: 6,
  bed_discharge_forecast: 5,
  pharmacy_stockout_predictor: 5,
  quality_case_review: 12,
  admin_policy_copilot: 3,
  self_healing_bug_hunt: 4,
  soap_from_dictation: 15,
  patient_communication_translation: 8,
  abdm_longitudinal_risk: 4,
  appointment_no_show_predictor: 2,
  ot_case_time_predictor: 3,
  charge_capture_audit: 5,
  deterioration_early_warning: 3,
  polypharmacy_ai_review: 8,
  clinical_trial_matcher: 10,
  patient_record_chatbot: 3,
  rca_draft_generator: 20,
  prior_authorization_generator: 25,
  radiology_ai_interpretation: 12,
  document_intelligence_ocr: 10,
  chart_completion_auditor: 8,
  consent_phi_policy_sentinel: 4,
  infection_control_sentinel: 10,
  sepsis_bundle_sentinel: 12,
  virtual_ward_triage: 5,
  ambient_visit_documentation: 20,
  staff_roster_optimizer: 25,
  appeal_letter_generator: 30,
  patient_teach_back_comprehension: 7,
};
const DEFAULT_TIME_SAVED_MIN_FALLBACK = 8;
const DOCUMENTATION_MODULE_KEYS = new Set([
  'discharge_summary',
  'handover_summary',
  'patient_record_summary',
  'patient_aftercare_instructions',
  'referral_letter',
  'soap_from_dictation',
  'ambient_visit_documentation',
  'rca_draft_generator',
  'prior_authorization_generator',
  'appeal_letter_generator',
]);

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampDays(value, { min = 1, max = 365, fallback = 30 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSnapshotRow(row) {
  if (!row) return row;
  return {
    ...row,
    generation_count: toFiniteNumber(row.generation_count),
    ai_generation_count: toFiniteNumber(row.ai_generation_count),
    fallback_count: toFiniteNumber(row.fallback_count),
    accepted_count: toFiniteNumber(row.accepted_count),
    rejected_count: toFiniteNumber(row.rejected_count),
    pending_count: toFiniteNumber(row.pending_count),
    edited_count: toFiniteNumber(row.edited_count),
    total_tokens: toFiniteNumber(row.total_tokens),
    total_cost_minor: toFiniteNumber(row.total_cost_minor),
    acceptance_rate_pct: toFiniteNumber(row.acceptance_rate_pct),
    time_saved_minutes: toFiniteNumber(row.time_saved_minutes),
    documentation_hours_saved: toFiniteNumber(row.documentation_hours_saved),
    denial_value_prevented_minor: toFiniteNumber(row.denial_value_prevented_minor),
    prior_auth_approved_count: toFiniteNumber(row.prior_auth_approved_count),
    appeal_approved_count: toFiniteNumber(row.appeal_approved_count),
    cost_per_useful_draft_minor: toFiniteNumber(row.cost_per_useful_draft_minor),
  };
}

function moduleTimeSavedMinutes(moduleKey, moduleOverrides = {}) {
  if (Object.prototype.hasOwnProperty.call(moduleOverrides, moduleKey)) {
    return toFiniteNumber(moduleOverrides[moduleKey], DEFAULT_TIME_SAVED_MIN_FALLBACK);
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_MODULE_TIME_SAVED_MIN, moduleKey)) {
    return DEFAULT_MODULE_TIME_SAVED_MIN[moduleKey];
  }
  return DEFAULT_TIME_SAVED_MIN_FALLBACK;
}

export function calculateAcceptanceRate({ accepted = 0, total = 0 } = {}) {
  const a = toFiniteNumber(accepted);
  const t = toFiniteNumber(total);
  if (t <= 0) return 0;
  const raw = (a / t) * 100;
  return Math.round(raw * 100) / 100;
}

export function calculateTimeSaved({
  moduleKey,
  acceptedCount = 0,
  moduleOverrides = {},
} = {}) {
  const minutesPerAccepted = moduleTimeSavedMinutes(moduleKey, moduleOverrides);
  const accepted = Math.max(0, toFiniteNumber(acceptedCount));
  return Math.round(minutesPerAccepted * accepted);
}

export function calculateCostPerUsefulDraft({
  totalCostMinor = 0,
  acceptedCount = 0,
} = {}) {
  const cost = Math.max(0, toFiniteNumber(totalCostMinor));
  const accepted = Math.max(0, toFiniteNumber(acceptedCount));
  if (accepted <= 0) return 0;
  const ratio = cost / accepted;
  return Math.round(ratio * 100) / 100;
}

export function aggregateRoiMetrics({
  generations = [],
  reviews = [],
  appealApprovals = [],
  priorAuthApprovals = [],
  moduleOverrides = {},
} = {}) {
  const reviewMap = new Map();
  for (const row of asArray(reviews)) {
    if (!row || !row.module_key) continue;
    reviewMap.set(row.module_key, {
      accepted: toFiniteNumber(row.accepted_count),
      rejected: toFiniteNumber(row.rejected_count),
      pending: toFiniteNumber(row.pending_count),
      edited: toFiniteNumber(row.edited_count),
    });
  }

  const byModule = [];
  const overall = {
    generation_count: 0,
    ai_generation_count: 0,
    fallback_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    pending_count: 0,
    edited_count: 0,
    total_tokens: 0,
    total_cost_minor: 0,
    time_saved_minutes: 0,
    documentation_minutes_saved: 0,
  };

  for (const row of asArray(generations)) {
    if (!row || !row.module_key) continue;
    const moduleKey = row.module_key;
    const reviewStats = reviewMap.get(moduleKey) || { accepted: 0, rejected: 0, pending: 0, edited: 0 };
    const generationCount = toFiniteNumber(row.generation_count);
    const aiGenerationCount = toFiniteNumber(row.ai_generation_count);
    const fallbackCount = toFiniteNumber(row.fallback_count);
    const totalTokens = toFiniteNumber(row.total_tokens);
    const totalCostMinor = toFiniteNumber(row.total_cost_minor ?? row.estimated_cost_minor);
    const accepted = reviewStats.accepted;
    const acceptanceRate = calculateAcceptanceRate({ accepted, total: generationCount });
    const timeSavedMinutes = calculateTimeSaved({ moduleKey, acceptedCount: accepted, moduleOverrides });
    const costPerUseful = calculateCostPerUsefulDraft({ totalCostMinor, acceptedCount: accepted });
    const documentationMinutes = DOCUMENTATION_MODULE_KEYS.has(moduleKey) ? timeSavedMinutes : 0;

    byModule.push({
      module_key: moduleKey,
      generation_count: generationCount,
      ai_generation_count: aiGenerationCount,
      fallback_count: fallbackCount,
      accepted_count: accepted,
      rejected_count: reviewStats.rejected,
      pending_count: reviewStats.pending,
      edited_count: reviewStats.edited,
      total_tokens: totalTokens,
      total_cost_minor: totalCostMinor,
      acceptance_rate_pct: acceptanceRate,
      time_saved_minutes: timeSavedMinutes,
      documentation_minutes_saved: documentationMinutes,
      cost_per_useful_draft_minor: costPerUseful,
    });

    overall.generation_count += generationCount;
    overall.ai_generation_count += aiGenerationCount;
    overall.fallback_count += fallbackCount;
    overall.accepted_count += accepted;
    overall.rejected_count += reviewStats.rejected;
    overall.pending_count += reviewStats.pending;
    overall.edited_count += reviewStats.edited;
    overall.total_tokens += totalTokens;
    overall.total_cost_minor += totalCostMinor;
    overall.time_saved_minutes += timeSavedMinutes;
    overall.documentation_minutes_saved += documentationMinutes;
  }

  const overallAcceptanceRate = calculateAcceptanceRate({
    accepted: overall.accepted_count,
    total: overall.generation_count,
  });
  const overallCostPerUseful = calculateCostPerUsefulDraft({
    totalCostMinor: overall.total_cost_minor,
    acceptedCount: overall.accepted_count,
  });

  const appealApprovedCount = asArray(appealApprovals).reduce(
    (sum, row) => sum + toFiniteNumber(row.approved_count),
    0
  );
  const appealValuePrevented = asArray(appealApprovals).reduce(
    (sum, row) => sum + toFiniteNumber(row.claim_amount_total),
    0
  );
  const priorAuthApprovedCount = asArray(priorAuthApprovals).reduce(
    (sum, row) => sum + toFiniteNumber(row.approved_count),
    0
  );

  byModule.sort((a, b) => b.generation_count - a.generation_count || a.module_key.localeCompare(b.module_key));

  const highlights = byModule
    .filter((row) => row.accepted_count > 0)
    .slice(0, 5)
    .map((row) => ({
      module_key: row.module_key,
      accepted_count: row.accepted_count,
      time_saved_minutes: row.time_saved_minutes,
      acceptance_rate_pct: row.acceptance_rate_pct,
      cost_per_useful_draft_minor: row.cost_per_useful_draft_minor,
    }));

  return {
    generation_count: overall.generation_count,
    ai_generation_count: overall.ai_generation_count,
    fallback_count: overall.fallback_count,
    accepted_count: overall.accepted_count,
    rejected_count: overall.rejected_count,
    pending_count: overall.pending_count,
    edited_count: overall.edited_count,
    total_tokens: overall.total_tokens,
    total_cost_minor: overall.total_cost_minor,
    acceptance_rate_pct: overallAcceptanceRate,
    time_saved_minutes: overall.time_saved_minutes,
    documentation_hours_saved: Math.round((overall.documentation_minutes_saved / 60) * 100) / 100,
    denial_value_prevented_minor: Math.round(appealValuePrevented),
    prior_auth_approved_count: priorAuthApprovedCount,
    appeal_approved_count: appealApprovedCount,
    cost_per_useful_draft_minor: overallCostPerUseful,
    by_module: byModule,
    highlights,
  };
}

async function queryGenerationsByModule(tenantId, periodDays) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(module_key, task_type) AS module_key,
         COUNT(*)::int AS generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 1 ELSE 0 END), 0)::int AS ai_generation_count,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallback_count,
         COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
         COALESCE(SUM(estimated_cost_minor), 0)::int AS total_cost_minor
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       GROUP BY COALESCE(module_key, task_type)`,
      tenantId,
      periodDays
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function queryReviewsByModule(tenantId, periodDays) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT
         module_key,
         COUNT(*) FILTER (WHERE decision = 'accepted')::int AS accepted_count,
         COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejected_count,
         COUNT(*) FILTER (WHERE decision = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE decision IN ('edited', 'revision_requested'))::int AS edited_count
       FROM clinical_ai_reviews
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
       GROUP BY module_key`,
      tenantId,
      periodDays
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function queryAppealApprovals(tenantId, periodDays) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS approved_count,
         COALESCE(SUM(c.claim_amount), 0)::numeric AS claim_amount_total
       FROM clinical_ai_appeal_letters a
       LEFT JOIN insurance_claims c ON c.id = a.claim_id
       WHERE a.tenant_id = $1::uuid
         AND a.appeal_status = 'approved'
         AND a.payer_response_at >= NOW() - ($2::int * INTERVAL '1 day')`,
      tenantId,
      periodDays
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function queryPriorAuthApprovals(tenantId, periodDays) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS approved_count
       FROM clinical_ai_prior_auth_requests
       WHERE tenant_id = $1::uuid
         AND status = 'approved'
         AND payer_decided_at >= NOW() - ($2::int * INTERVAL '1 day')`,
      tenantId,
      periodDays
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function loadModuleTimeOverrides(tenantId) {
  try {
    const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
    const overrides = module?.settings?.moduleTimeSavedMinutes;
    if (!overrides || typeof overrides !== 'object') return {};
    const normalized = {};
    for (const [key, value] of Object.entries(overrides)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) normalized[key] = parsed;
    }
    return normalized;
  } catch (err) {
    logger.warn('AI ROI module overrides failed to load', { error: err.message });
    return {};
  }
}

export async function computeAiRoiMetrics({
  tenantId = null,
  periodDays = 30,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const days = clampDays(periodDays);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000);

  const moduleOverrides = await loadModuleTimeOverrides(tid);
  const [generations, reviews, appeals, priorAuths] = await Promise.all([
    queryGenerationsByModule(tid, days),
    queryReviewsByModule(tid, days),
    queryAppealApprovals(tid, days),
    queryPriorAuthApprovals(tid, days),
  ]);

  const aggregated = aggregateRoiMetrics({
    generations,
    reviews,
    appealApprovals: appeals,
    priorAuthApprovals: priorAuths,
    moduleOverrides,
  });

  return {
    tenant_id: tid,
    module_key: 'ALL',
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    period_days: days,
    ...aggregated,
    computed_at: new Date().toISOString(),
    decision_support_only: true,
    read_only: true,
  };
}

export async function saveAiRoiSnapshot({
  tenantId = null,
  metrics,
  moduleKey = 'ALL',
  computedBy = null,
} = {}) {
  if (!metrics || typeof metrics !== 'object') {
    throw AppError.badRequest('metrics payload is required');
  }
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_roi_snapshots
         (tenant_id, period_start, period_end, period_days, module_key,
          generation_count, ai_generation_count, fallback_count,
          accepted_count, rejected_count, pending_count, edited_count,
          total_tokens, total_cost_minor, acceptance_rate_pct,
          time_saved_minutes, documentation_hours_saved,
          denial_value_prevented_minor, prior_auth_approved_count,
          appeal_approved_count, cost_per_useful_draft_minor,
          by_module, highlights, metadata, computed_at, computed_by)
       VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4, $5,
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
               $22::jsonb, $23::jsonb, $24::jsonb, NOW(), $25::uuid)
       RETURNING id, tenant_id, period_start, period_end, period_days, module_key,
                 generation_count, accepted_count, acceptance_rate_pct,
                 time_saved_minutes, documentation_hours_saved,
                 denial_value_prevented_minor, cost_per_useful_draft_minor,
                 appeal_approved_count, prior_auth_approved_count,
                 computed_at, computed_by`,
      tid,
      metrics.period_start,
      metrics.period_end,
      clampDays(metrics.period_days),
      cleanText(moduleKey) || 'ALL',
      toFiniteNumber(metrics.generation_count),
      toFiniteNumber(metrics.ai_generation_count),
      toFiniteNumber(metrics.fallback_count),
      toFiniteNumber(metrics.accepted_count),
      toFiniteNumber(metrics.rejected_count),
      toFiniteNumber(metrics.pending_count),
      toFiniteNumber(metrics.edited_count),
      toFiniteNumber(metrics.total_tokens),
      toFiniteNumber(metrics.total_cost_minor),
      toFiniteNumber(metrics.acceptance_rate_pct),
      toFiniteNumber(metrics.time_saved_minutes),
      toFiniteNumber(metrics.documentation_hours_saved),
      toFiniteNumber(metrics.denial_value_prevented_minor),
      toFiniteNumber(metrics.prior_auth_approved_count),
      toFiniteNumber(metrics.appeal_approved_count),
      toFiniteNumber(metrics.cost_per_useful_draft_minor),
      JSON.stringify(metrics.by_module || []),
      JSON.stringify(metrics.highlights || []),
      JSON.stringify({ read_only: true, decision_support_only: true }),
      computedBy
    );
    return normalizeSnapshotRow(rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listAiRoiSnapshots({
  tenantId = null,
  moduleKey = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const safeModule = moduleKey ? cleanText(moduleKey) : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, period_start, period_end, period_days, module_key,
              generation_count, ai_generation_count, fallback_count,
              accepted_count, rejected_count, pending_count, edited_count,
              total_tokens, total_cost_minor, acceptance_rate_pct,
              time_saved_minutes, documentation_hours_saved,
              denial_value_prevented_minor, prior_auth_approved_count,
              appeal_approved_count, cost_per_useful_draft_minor,
              by_module, highlights, metadata, computed_at, computed_by, created_at
       FROM clinical_ai_roi_snapshots
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR module_key = $2)
       ORDER BY computed_at DESC
       LIMIT $3`,
      tid,
      safeModule,
      safeLimit
    );
    const normalized = rows.map(normalizeSnapshotRow);
    return { snapshots: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { snapshots: [], count: 0 };
    throw err;
  }
}

export async function getLatestAiRoiSnapshot({ tenantId = null, moduleKey = 'ALL' } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeModule = cleanText(moduleKey) || 'ALL';
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, period_start, period_end, period_days, module_key,
              generation_count, accepted_count, acceptance_rate_pct,
              time_saved_minutes, documentation_hours_saved,
              denial_value_prevented_minor, cost_per_useful_draft_minor,
              by_module, highlights, metadata, computed_at
       FROM clinical_ai_roi_snapshots
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY computed_at DESC
       LIMIT 1`,
      tid,
      safeModule
    );
    return normalizeSnapshotRow(rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export default {
  aggregateRoiMetrics,
  calculateAcceptanceRate,
  calculateCostPerUsefulDraft,
  calculateTimeSaved,
  computeAiRoiMetrics,
  getLatestAiRoiSnapshot,
  listAiRoiSnapshots,
  saveAiRoiSnapshot,
};
