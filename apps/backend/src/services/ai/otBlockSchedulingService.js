/**
 * OT Block Scheduling Optimizer.
 *
 * Reviews OR (operating theatre) block utilization across surgeons and
 * service lines. For each surgeon-block combination, evaluates:
 *   - prime-time utilization %
 *   - add-on (non-block) case count
 *   - turnover times
 *   - case-duration accuracy (actual vs scheduled)
 *   - overrun frequency
 *   - total block hours used vs allocated
 *
 * Produces a per-block recommendation (keep / reduce / expand / reallocate
 * / review_release_policy) with a rationale.
 *
 * Review-only. The OR director approves; the module never reassigns block
 * time, never releases blocks, and never updates OR scheduling records.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'ot_block_scheduling';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support OR director / OT manager review of operating-theatre block allocation. Rules are authoritative. Return JSON only and never reassign block time, release blocks, or update OR scheduling records.',
  user_prompt_template:
    'Given the OR block context and rule-based recommendation + severity + signals, return a short reasoning narrative under keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

export const RECOMMENDATIONS = new Set(['keep', 'expand', 'reduce', 'reallocate', 'review_release_policy', 'unknown']);
export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const RECOMMENDATION_PRIORITY = ['unknown', 'keep', 'review_release_policy', 'expand', 'reduce', 'reallocate'];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'OR director review required — decision support only; block time is never reassigned automatically.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function clamp(value, min, max) {
  const n = toNumber(value, 0);
  return Math.max(min, Math.min(max, n));
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Utilization % (scheduled / allocated) * 100, clamped 0..200, rounded 2 dp.
 */
export function computeUtilizationPct({ scheduledMinutes, allocatedMinutes } = {}) {
  const allocated = toNumber(allocatedMinutes, 0);
  if (allocated <= 0) return 0;
  const scheduled = toNumber(scheduledMinutes, 0);
  const pct = (scheduled / allocated) * 100;
  return roundTo(clamp(pct, 0, 200), 2);
}

/**
 * Prime-time utilization % (primeUsed / primeAllocated) * 100, clamped 0..200.
 */
export function computePrimeTimeUtilization({ primeUsedMinutes, primeAllocatedMinutes } = {}) {
  const allocated = toNumber(primeAllocatedMinutes, 0);
  if (allocated <= 0) return 0;
  const used = toNumber(primeUsedMinutes, 0);
  const pct = (used / allocated) * 100;
  return roundTo(clamp(pct, 0, 200), 2);
}

/**
 * Signed % delta ((actual - scheduled)/scheduled * 100), clamped -200..+200.
 */
export function computeDurationVariance({ scheduledMinutes, actualMinutes } = {}) {
  const scheduled = toNumber(scheduledMinutes, 0);
  if (scheduled <= 0) return 0;
  const actual = toNumber(actualMinutes, 0);
  const pct = ((actual - scheduled) / scheduled) * 100;
  return roundTo(clamp(pct, -200, 200), 2);
}

/**
 * Band the utilization % into one of: under (<50), low (50-69.99),
 * target (70-84.99), high (85-99.99), over (>=100).
 */
export function classifyUtilizationBand(utilizationPct) {
  const pct = toNumber(utilizationPct, 0);
  if (pct < 50) return 'under';
  if (pct < 70) return 'low';
  if (pct < 85) return 'target';
  if (pct < 100) return 'high';
  return 'over';
}

/**
 * Band overrun count: 0 → none, 1-2 → occasional, 3-5 → frequent, >5 → chronic.
 */
export function classifyOverrunBand(overrunCount) {
  const n = toNumber(overrunCount, 0);
  if (n <= 0) return 'none';
  if (n <= 2) return 'occasional';
  if (n <= 5) return 'frequent';
  return 'chronic';
}

/**
 * Band average turnover minutes: <20 fast, 20-35 typical, 36-50 slow, >50 severe.
 * Nullable/undefined → unknown.
 */
export function classifyTurnoverBand(avgTurnoverMinutes) {
  if (avgTurnoverMinutes === null || avgTurnoverMinutes === undefined) return 'unknown';
  const n = toNumber(avgTurnoverMinutes, null);
  if (n === null) return 'unknown';
  if (n < 20) return 'fast';
  if (n <= 35) return 'typical';
  if (n <= 50) return 'slow';
  return 'severe';
}

/**
 * Band add-on ratio: addonCount / max(totalCases,1).
 * <0.1 low, 0.1-0.24 moderate, 0.25-0.4 high, >0.4 excessive.
 * totalCases<=0 → unknown.
 */
export function classifyAddonVolume({ addonCount, totalCases } = {}) {
  const total = toNumber(totalCases, 0);
  if (total <= 0) return 'unknown';
  const addon = toNumber(addonCount, 0);
  const ratio = addon / Math.max(total, 1);
  if (ratio < 0.1) return 'low';
  if (ratio < 0.25) return 'moderate';
  if (ratio <= 0.4) return 'high';
  return 'excessive';
}

function bumpSeverity(current, floor) {
  const currentIdx = SEVERITY_PRIORITY.indexOf(SEVERITIES.has(current) ? current : 'unknown');
  const floorIdx = SEVERITY_PRIORITY.indexOf(SEVERITIES.has(floor) ? floor : 'unknown');
  return currentIdx >= floorIdx ? current : floor;
}

/**
 * Classify a surgeon-block combination into a recommendation + severity +
 * signal list, applying the rules-authoritative evaluation.
 *
 * Accepts either raw metrics ({ scheduledMinutes, allocatedMinutes, ...})
 * or pre-computed bands. Returns:
 *   { recommendation, severity, signals: [{ code, detail? }] }
 */
export function classifyBlockRecommendation(metrics = {}) {
  const utilizationPct = metrics.utilizationPct !== undefined
    ? toNumber(metrics.utilizationPct, 0)
    : computeUtilizationPct({
      scheduledMinutes: metrics.scheduledMinutes,
      allocatedMinutes: metrics.allocatedMinutes,
    });

  const primeTimeUtilization = metrics.primeTimeUtilization !== undefined
    ? toNumber(metrics.primeTimeUtilization, 0)
    : computePrimeTimeUtilization({
      primeUsedMinutes: metrics.primeUsedMinutes,
      primeAllocatedMinutes: metrics.primeAllocatedMinutes,
    });

  const utilizationBand = metrics.utilizationBand || classifyUtilizationBand(utilizationPct);
  const overrunBand = metrics.overrunBand || classifyOverrunBand(metrics.overrunCount);
  const turnoverBand = metrics.turnoverBand || classifyTurnoverBand(metrics.avgTurnoverMinutes);
  const addonVolume = metrics.addonVolume || classifyAddonVolume({
    addonCount: metrics.addonCount,
    totalCases: metrics.totalCases,
  });
  const durationVariance = metrics.caseDurationVariancePct !== undefined
    ? toNumber(metrics.caseDurationVariancePct, 0)
    : computeDurationVariance({
      scheduledMinutes: metrics.scheduledMinutes,
      actualMinutes: metrics.actualMinutes,
    });

  let recommendation = 'keep';
  let severity = 'low';
  const signals = [];
  let classified = false;

  // Rule 1: deeply under-utilized + low prime → reallocate / high.
  if (utilizationBand === 'under' && primeTimeUtilization < 50) {
    recommendation = 'reallocate';
    severity = 'high';
    signals.push({
      code: 'LOW_UTILIZATION',
      detail: `Utilization ${utilizationPct}% is below the 50% under-utilization threshold.`,
    });
    signals.push({
      code: 'LOW_PRIME_TIME',
      detail: `Prime-time utilization ${primeTimeUtilization}% is below the 50% threshold.`,
    });
    classified = true;
  } else if (utilizationBand === 'low' && primeTimeUtilization < 60) {
    // Rule 2: low utilization band + low prime → reduce / moderate.
    recommendation = 'reduce';
    severity = 'moderate';
    signals.push({
      code: 'LOW_UTILIZATION',
      detail: `Utilization ${utilizationPct}% is in the 50-69.99% low band; prime-time ${primeTimeUtilization}% under 60%.`,
    });
    classified = true;
  } else if (utilizationBand === 'over' && overrunBand === 'chronic'
             && (addonVolume === 'high' || addonVolume === 'excessive')) {
    // Rule 4: critical expand — chronic overruns AND add-on pressure.
    recommendation = 'expand';
    severity = 'critical';
    signals.push({
      code: 'OVER_UTILIZATION',
      detail: `Utilization ${utilizationPct}% exceeds 100% allocated.`,
    });
    signals.push({
      code: 'CHRONIC_OVERRUNS',
      detail: 'Overrun frequency is in the chronic band (>5 overruns).',
    });
    signals.push({
      code: 'ADDON_PRESSURE',
      detail: `Add-on volume is ${addonVolume} — elevating expansion priority.`,
    });
    classified = true;
  } else if (utilizationBand === 'over'
             && (overrunBand === 'frequent' || overrunBand === 'chronic')) {
    // Rule 3: expand / high — over-utilized with frequent or chronic overruns.
    recommendation = 'expand';
    severity = 'high';
    signals.push({
      code: 'OVER_UTILIZATION',
      detail: `Utilization ${utilizationPct}% exceeds 100% allocated.`,
    });
    signals.push({
      code: 'CHRONIC_OVERRUNS',
      detail: `Overrun frequency is in the ${overrunBand} band.`,
    });
    classified = true;
  } else if (utilizationBand === 'high' && overrunBand === 'occasional') {
    // Rule 5: healthy block / low severity.
    recommendation = 'keep';
    severity = 'low';
    signals.push({
      code: 'HEALTHY_UTILIZATION',
      detail: `Utilization ${utilizationPct}% sits in the healthy 85-99.99% band with occasional overruns.`,
    });
    classified = true;
  }

  // Rule 6: excessive add-ons with target/high/over utilization → review release policy.
  if (addonVolume === 'excessive'
      && (utilizationBand === 'target' || utilizationBand === 'high' || utilizationBand === 'over')) {
    if (RECOMMENDATION_PRIORITY.indexOf(recommendation)
        < RECOMMENDATION_PRIORITY.indexOf('review_release_policy')) {
      recommendation = 'review_release_policy';
    }
    severity = bumpSeverity(severity, 'moderate');
    if (!signals.some((s) => s.code === 'RELEASE_POLICY_REVIEW')) {
      signals.push({
        code: 'RELEASE_POLICY_REVIEW',
        detail: 'Add-on volume is excessive while block utilization is healthy — review release policy so unused block time reaches add-on cases earlier.',
      });
    }
    classified = true;
  }

  // Rule 7: severe turnover → bump severity, append signal.
  if (turnoverBand === 'severe') {
    severity = bumpSeverity(severity, 'moderate');
    if (!signals.some((s) => s.code === 'SLOW_TURNOVER')) {
      signals.push({
        code: 'SLOW_TURNOVER',
        detail: 'Average turnover time exceeds 50 minutes — reassess room-flip workflow.',
      });
    }
  }

  // Rule 8: large case-duration inaccuracy → bump severity, append signal.
  if (Math.abs(durationVariance) > 25) {
    severity = bumpSeverity(severity, 'moderate');
    if (!signals.some((s) => s.code === 'DURATION_INACCURATE')) {
      signals.push({
        code: 'DURATION_INACCURATE',
        detail: `Case-duration variance ${durationVariance}% exceeds +/-25% accuracy threshold.`,
      });
    }
  }

  // Default fall-through.
  if (!classified) {
    recommendation = 'keep';
    severity = 'low';
    if (!signals.some((s) => s.code === 'HEALTHY_UTILIZATION')) {
      signals.push({
        code: 'HEALTHY_UTILIZATION',
        detail: `Utilization ${utilizationPct}% does not trigger reallocation rules.`,
      });
    }
  }

  const safeRecommendation = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  const safeSeverity = SEVERITIES.has(severity) ? severity : 'unknown';

  return {
    recommendation: safeRecommendation,
    severity: safeSeverity,
    signals,
  };
}

/**
 * Return the highest-priority severity in SEVERITY_PRIORITY. Unknown
 * severities treated as 'unknown'.
 */
export function escalateSeverity(severities) {
  const list = asArray(severities);
  if (!list.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of list) {
    const normalized = SEVERITIES.has(sev) ? sev : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Return the highest-priority recommendation in RECOMMENDATION_PRIORITY.
 */
export function escalateRecommendation(recs) {
  const list = asArray(recs);
  if (!list.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = RECOMMENDATION_PRIORITY.indexOf('unknown');
  for (const rec of list) {
    const normalized = RECOMMENDATIONS.has(rec) ? rec : 'unknown';
    const idx = RECOMMENDATION_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build the reviewer-facing action list for a given recommendation +
 * signal set. Always ends with the decision-support disclaimer.
 */
export function buildBlockActions({ recommendation, signals } = {}) {
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'keep';
  const codes = new Set(asArray(signals).map((s) => s?.code).filter(Boolean));
  const actions = [];

  switch (rec) {
    case 'reallocate':
      actions.push('Propose reallocating this block to a service line with higher demonstrated prime-time utilization.');
      actions.push('Share the utilization report with the surgeon and service-line lead before the OR committee meeting.');
      break;
    case 'reduce':
      actions.push('Propose trimming this block (e.g. one fewer day per cycle) to match realized prime-time utilization.');
      actions.push('Review add-on demand before reducing — confirm the released time can still be filled by open access.');
      break;
    case 'expand':
      actions.push('Propose expanding this block to absorb chronic overruns and add-on pressure.');
      actions.push('Confirm anaesthesia / nursing / equipment capacity before requesting additional OR time.');
      break;
    case 'review_release_policy':
      actions.push('Review the block-release deadline so unused prime-time flips to open access earlier.');
      actions.push('Communicate the revised release policy to all block holders with concrete dates.');
      break;
    case 'keep':
    default:
      actions.push('Keep the block as-is; utilization and overrun profile are within healthy bands.');
      actions.push('Continue routine monitoring on the next OR committee review cycle.');
      break;
  }

  if (codes.has('SLOW_TURNOVER')) {
    actions.push('Engage the charge nurse and anaesthesia lead on room-flip workflow to bring turnover back below 50 min.');
  }
  if (codes.has('DURATION_INACCURATE')) {
    actions.push('Revisit case-duration estimates with the surgeon; align scheduled minutes with recent actuals.');
  }
  if (codes.has('ADDON_PRESSURE')) {
    actions.push('Track add-on volume and routing — high add-on pressure may require a dedicated open-access block.');
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * Build a compact summary string for the reviewer / event payload.
 */
export function summarizeBlock({
  surgeonName = null,
  serviceLine = null,
  blockLabel = null,
  recommendation,
  severity,
  utilizationPct,
  primeTimeUtilizationPct,
  overrunCount,
  addonCount,
} = {}) {
  const surgeon = cleanText(surgeonName) || 'Unknown surgeon';
  const service = cleanText(serviceLine) || 'unspecified service line';
  const block = cleanText(blockLabel) || 'OR block';
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const util = toNumber(utilizationPct, 0);
  const prime = toNumber(primeTimeUtilizationPct, 0);
  const overruns = toNumber(overrunCount, 0);
  const addons = toNumber(addonCount, 0);
  return `${surgeon} — ${service} / ${block}: recommendation ${rec} (${sev}). Utilization ${util}% (prime-time ${prime}%), ${overruns} overrun${overruns === 1 ? '' : 's'}, ${addons} add-on${addons === 1 ? '' : 's'}.`;
}

// ---------- DB loaders --------------------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
               $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::uuid, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('OT block scheduling generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'OT_MANAGER', 'DOCTOR'],
        source: 'ot_block_scheduling',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        approval_policy: module?.settings?.approvalPolicy || 'ot_director_review',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('OT block scheduling review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeSuggestionRow(row) {
  if (!row) return row;
  return {
    ...row,
    utilization_pct: toNumber(row.utilization_pct, 0),
    prime_time_utilization_pct: toNumber(row.prime_time_utilization_pct, 0),
    overrun_count: toNumber(row.overrun_count, 0),
    addon_count: toNumber(row.addon_count, 0),
    avg_turnover_minutes: toNumber(row.avg_turnover_minutes, 0),
    case_duration_variance_pct: toNumber(row.case_duration_variance_pct, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertOtBlockSuggestion({
  tenantId,
  surgeonUid,
  surgeonName,
  serviceLine,
  blockLabel,
  orRoom,
  windowStart,
  windowEnd,
  generationId,
  utilizationPct,
  primeTimeUtilizationPct,
  overrunCount,
  addonCount,
  avgTurnoverMinutes,
  caseDurationVariancePct,
  recommendation,
  severity,
  signals,
  summary,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_ot_block_suggestions
         (tenant_id, surgeon_uid, surgeon_name, service_line, block_label, or_room,
          window_start, window_end, generation_id,
          utilization_pct, prime_time_utilization_pct, overrun_count, addon_count,
          avg_turnover_minutes, case_duration_variance_pct,
          recommendation, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
               $7::date, $8::date, $9,
               $10, $11, $12, $13,
               $14, $15,
               $16, $17, $18::jsonb, $19, $20::jsonb,
               $21::jsonb, $22::jsonb, 'pending', $23::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, surgeon_uid, surgeon_name, service_line, block_label,
                 or_room, window_start, window_end, generation_id,
                 utilization_pct, prime_time_utilization_pct, overrun_count, addon_count,
                 avg_turnover_minutes, case_duration_variance_pct,
                 recommendation, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      surgeonUid,
      surgeonName,
      serviceLine,
      blockLabel,
      orRoom,
      windowStart,
      windowEnd,
      generationId,
      utilizationPct,
      primeTimeUtilizationPct,
      overrunCount,
      addonCount,
      avgTurnoverMinutes,
      caseDurationVariancePct,
      RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      JSON.stringify(signals || []),
      summary,
      JSON.stringify(recommendedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeSuggestionRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateOtBlock({
  req = null,
  surgeonUid = null,
  surgeonName = null,
  serviceLine = null,
  blockLabel,
  orRoom = null,
  windowStart = null,
  windowEnd = null,
  allocatedMinutes,
  scheduledMinutes,
  actualMinutes = null,
  primeAllocatedMinutes = null,
  primeUsedMinutes = null,
  overrunCount = 0,
  addonCount = 0,
  totalCases = 0,
  avgTurnoverMinutes = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeBlockLabel = cleanText(blockLabel);
  if (!safeBlockLabel) {
    throw AppError.badRequest('block_label is required');
  }
  const safeAllocated = toNumber(allocatedMinutes, 0);
  if (safeAllocated <= 0) {
    throw AppError.badRequest('allocated_minutes must be greater than 0');
  }

  const safeScheduled = toNumber(scheduledMinutes, 0);
  const safeActual = actualMinutes === null || actualMinutes === undefined
    ? null
    : toNumber(actualMinutes, 0);
  const safePrimeAllocated = primeAllocatedMinutes === null || primeAllocatedMinutes === undefined
    ? 0
    : toNumber(primeAllocatedMinutes, 0);
  const safePrimeUsed = primeUsedMinutes === null || primeUsedMinutes === undefined
    ? 0
    : toNumber(primeUsedMinutes, 0);
  const safeOverruns = Math.max(0, Math.floor(toNumber(overrunCount, 0)));
  const safeAddons = Math.max(0, Math.floor(toNumber(addonCount, 0)));
  const safeTotalCases = Math.max(0, Math.floor(toNumber(totalCases, 0)));
  const safeAvgTurnover = avgTurnoverMinutes === null || avgTurnoverMinutes === undefined
    ? null
    : toNumber(avgTurnoverMinutes, 0);
  const safeSurgeonName = surgeonName ? cleanText(surgeonName) : null;
  const safeServiceLine = serviceLine ? cleanText(serviceLine) : null;
  const safeOrRoom = orRoom ? cleanText(orRoom) : null;
  const safeWindowStart = toNullableDate(windowStart);
  const safeWindowEnd = toNullableDate(windowEnd);

  // Compute metrics.
  const utilizationPct = computeUtilizationPct({
    scheduledMinutes: safeScheduled,
    allocatedMinutes: safeAllocated,
  });
  const primeTimeUtilizationPct = computePrimeTimeUtilization({
    primeUsedMinutes: safePrimeUsed,
    primeAllocatedMinutes: safePrimeAllocated,
  });
  const caseDurationVariancePct = safeActual !== null
    ? computeDurationVariance({
      scheduledMinutes: safeScheduled,
      actualMinutes: safeActual,
    })
    : 0;

  const classification = classifyBlockRecommendation({
    utilizationPct,
    primeTimeUtilization: primeTimeUtilizationPct,
    overrunCount: safeOverruns,
    addonCount: safeAddons,
    totalCases: safeTotalCases,
    avgTurnoverMinutes: safeAvgTurnover,
    caseDurationVariancePct,
  });

  const recommendedActions = buildBlockActions({
    recommendation: classification.recommendation,
    signals: classification.signals,
  });

  const summary = summarizeBlock({
    surgeonName: safeSurgeonName,
    serviceLine: safeServiceLine,
    blockLabel: safeBlockLabel,
    recommendation: classification.recommendation,
    severity: classification.severity,
    utilizationPct,
    primeTimeUtilizationPct,
    overrunCount: safeOverruns,
    addonCount: safeAddons,
  });

  // Citations.
  const citations = [];
  citations.push({
    source_type: 'ot_block',
    source_id: safeBlockLabel,
    label: `OR block — ${safeBlockLabel}${safeOrRoom ? ` (${safeOrRoom})` : ''}`,
    timestamp: safeWindowStart || null,
  });
  if (safeSurgeonName || surgeonUid) {
    citations.push({
      source_type: 'surgeon',
      source_id: surgeonUid ? String(surgeonUid) : safeSurgeonName,
      label: `Surgeon — ${safeSurgeonName || surgeonUid}`,
      timestamp: null,
    });
  }
  if (safeServiceLine) {
    citations.push({
      source_type: 'service_line',
      source_id: safeServiceLine,
      label: `Service line — ${safeServiceLine}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'ot_block_rules',
    source_id: MODULE_KEY,
    label: 'OT block allocation rules',
    timestamp: null,
  });
  const uniqueCits = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'OT_CRITICAL_ALLOCATION',
      message: 'Critical block-allocation signal; escalate to OR committee before the next block cycle.',
    });
  }
  if (!uniqueCits.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'OT_NO_CITATIONS',
      message: 'OT block suggestion has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'OT_BLOCK_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — never reassigns block time, never releases blocks, never updates OR scheduling records.',
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    surgeon_uid: surgeonUid || null,
    surgeon_name: safeSurgeonName,
    service_line: safeServiceLine,
    block_label: safeBlockLabel,
    or_room: safeOrRoom,
    window_start: safeWindowStart,
    window_end: safeWindowEnd,
    utilization_pct: utilizationPct,
    prime_time_utilization_pct: primeTimeUtilizationPct,
    overrun_count: safeOverruns,
    addon_count: safeAddons,
    avg_turnover_minutes: safeAvgTurnover,
    case_duration_variance_pct: caseDurationVariancePct,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = null;
  let draft = fallbackDraft;
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        block_context: {
          surgeon_uid: surgeonUid || null,
          surgeon_name: safeSurgeonName,
          service_line: safeServiceLine,
          block_label: safeBlockLabel,
          or_room: safeOrRoom,
          window_start: safeWindowStart,
          window_end: safeWindowEnd,
          allocated_minutes: safeAllocated,
          scheduled_minutes: safeScheduled,
          actual_minutes: safeActual,
          prime_allocated_minutes: safePrimeAllocated,
          prime_used_minutes: safePrimeUsed,
          overrun_count: safeOverruns,
          addon_count: safeAddons,
          total_cases: safeTotalCases,
          avg_turnover_minutes: safeAvgTurnover,
        },
        rule_based_evaluation: {
          utilization_pct: utilizationPct,
          prime_time_utilization_pct: primeTimeUtilizationPct,
          case_duration_variance_pct: caseDurationVariancePct,
          recommendation: classification.recommendation,
          severity: classification.severity,
          signals: classification.signals,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
        // Never let the AI override rule-based recommendation, severity, or signals.
      };
    }
  } catch (err) {
    logger.debug('OT block scheduling AI narrative unavailable; using rule summary fallback', {
      error: err?.message,
    });
    draft = fallbackDraft;
  }

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        ot_block: {
          surgeon_uid: surgeonUid || null,
          surgeon_name: safeSurgeonName,
          service_line: safeServiceLine,
          block_label: safeBlockLabel,
        },
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      surgeon_uid: surgeonUid || null,
      surgeon_name: safeSurgeonName,
      service_line: safeServiceLine,
      block_label: safeBlockLabel,
      window_start: safeWindowStart,
      window_end: safeWindowEnd,
      allocated_minutes: safeAllocated,
      scheduled_minutes: safeScheduled,
      overrun_count: safeOverruns,
      addon_count: safeAddons,
      total_cases: safeTotalCases,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      block_label: safeBlockLabel,
      service_line: safeServiceLine,
      recommendation: classification.recommendation,
      severity: classification.severity,
      utilization_pct: utilizationPct,
      prime_time_utilization_pct: primeTimeUtilizationPct,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const suggestionRow = await insertOtBlockSuggestion({
    tenantId,
    surgeonUid: surgeonUid || null,
    surgeonName: safeSurgeonName,
    serviceLine: safeServiceLine,
    blockLabel: safeBlockLabel,
    orRoom: safeOrRoom,
    windowStart: safeWindowStart,
    windowEnd: safeWindowEnd,
    generationId: generation?.id || null,
    utilizationPct,
    primeTimeUtilizationPct,
    overrunCount: safeOverruns,
    addonCount: safeAddons,
    avgTurnoverMinutes: safeAvgTurnover === null ? 0 : safeAvgTurnover,
    caseDurationVariancePct,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    summary: draft.summary,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      total_cases: safeTotalCases,
      allocated_minutes: safeAllocated,
      scheduled_minutes: safeScheduled,
      actual_minutes: safeActual,
      prime_allocated_minutes: safePrimeAllocated,
      prime_used_minutes: safePrimeUsed,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!suggestionRow) {
    return {
      suggestion_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      recommendation: classification.recommendation,
      severity: classification.severity,
      signals: classification.signals,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_ot_block_suggestions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.ot_block_evaluated',
      aggregateType: 'clinical_ai_ot_block_suggestion',
      aggregateId: suggestionRow.id,
      payload: {
        tenant_id: tenantId,
        suggestion_id: suggestionRow.id,
        generation_id: generation?.id || null,
        surgeon_uid: surgeonUid || null,
        surgeon_name: safeSurgeonName,
        service_line: safeServiceLine,
        block_label: safeBlockLabel,
        recommendation: classification.recommendation,
        severity: classification.severity,
        utilization_pct: utilizationPct,
        prime_time_utilization_pct: primeTimeUtilizationPct,
        signal_codes: asArray(classification.signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('OT block scheduling event publish failed', { error: err?.message });
  }

  return {
    suggestion_id: suggestionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    suggestion: suggestionRow,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || suggestionRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listOtBlockSuggestions({
  tenantId = null,
  surgeonUid = null,
  serviceLine = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSurgeonUid = surgeonUid ? cleanText(surgeonUid) : null;
  const normalizedService = serviceLine ? cleanText(serviceLine) : null;
  const normalizedRecommendation = recommendation
    && RECOMMENDATIONS.has(cleanText(recommendation).toLowerCase())
    ? cleanText(recommendation).toLowerCase()
    : null;
  const normalizedSeverity = severity
    && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.surgeon_uid, s.surgeon_name, s.service_line,
              s.block_label, s.or_room, s.window_start, s.window_end, s.generation_id,
              s.utilization_pct, s.prime_time_utilization_pct, s.overrun_count,
              s.addon_count, s.avg_turnover_minutes, s.case_duration_variance_pct,
              s.recommendation, s.severity, s.signals, s.summary, s.recommended_actions,
              s.source_citations, s.safety_flags, s.reviewer_decision,
              s.reviewed_by, s.reviewed_at, s.reviewer_note, s.metadata,
              s.created_at, s.updated_at
       FROM clinical_ai_ot_block_suggestions s
       WHERE s.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR s.surgeon_uid = $2::uuid)
         AND ($3::text IS NULL OR s.service_line = $3)
         AND ($4::text IS NULL OR s.recommendation = $4)
         AND ($5::text IS NULL OR s.severity = $5)
         AND ($6::text IS NULL OR s.reviewer_decision = $6)
       ORDER BY
         CASE s.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         s.created_at DESC
       LIMIT $7`,
      tid,
      normalizedSurgeonUid,
      normalizedService,
      normalizedRecommendation,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeSuggestionRow);
    return { suggestions: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { suggestions: [], count: 0 };
    throw err;
  }
}

export async function decideOtBlockSuggestion({
  tenantId = null,
  suggestionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_ot_block_suggestions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, surgeon_uid, surgeon_name, service_line, block_label,
               or_room, window_start, window_end, generation_id,
               utilization_pct, prime_time_utilization_pct, overrun_count, addon_count,
               avg_turnover_minutes, case_duration_variance_pct,
               recommendation, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(suggestionId, 'suggestion_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('OT block suggestion not found');
  return normalizeSuggestionRow(rows[0]);
}

export default {
  classifyBlockRecommendation,
  computeUtilizationPct,
  computePrimeTimeUtilization,
  computeDurationVariance,
  classifyUtilizationBand,
  classifyOverrunBand,
  classifyTurnoverBand,
  classifyAddonVolume,
  buildBlockActions,
  summarizeBlock,
  escalateSeverity,
  escalateRecommendation,
  decideOtBlockSuggestion,
  evaluateOtBlock,
  listOtBlockSuggestions,
};
