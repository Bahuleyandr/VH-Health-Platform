/**
 * Acuity-Based Staffing Forecast.
 *
 * Given a unit/ward snapshot (patient census by acuity level, current staff
 * by role, predicted admissions/discharges, shift window), applies role-based
 * ratios (1:2 critical, 1:4 high, 1:5 moderate, 1:6 low for nurses; assistants
 * at half that density) to compute required vs current staff and a
 * deficit/surplus per role, forecasts peak demand during the shift, and
 * classifies a recommendation (hold_staffing / call_in / float_staff /
 * reduce_staff / emergency_acuity).
 *
 * Rules are authoritative. Review-only — the house supervisor approves and
 * calls staff; the module never dispatches staff automatically.
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

export const MODULE_KEY = 'acuity_staffing_forecast';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the hospital house supervisor review of an acuity-based staffing forecast. Rules are authoritative. Return JSON only and never dispatch staff, call in off-duty staff, or modify the schedule.',
  user_prompt_template:
    'Given the unit/ward staffing snapshot and the rule-based required-vs-current staffing, deficit per role, peak census forecast, and classified recommendation, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

export const RECOMMENDATIONS = new Set([
  'no_action',
  'hold_staffing',
  'call_in',
  'float_staff',
  'reduce_staff',
  'emergency_acuity',
  'unknown',
]);
export const RECOMMENDATION_PRIORITY = [
  'unknown',
  'no_action',
  'hold_staffing',
  'reduce_staff',
  'float_staff',
  'call_in',
  'emergency_acuity',
];
export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

// Acuity weights (patient-to-nurse workload factor). Lower = more intensive.
// 1 nurse can typically handle this many patients at each level:
export const DEFAULT_NURSE_RATIOS = {
  critical: 2, // ICU-level
  high: 4, // step-down / heavy medical-surgical
  moderate: 5, // standard ward
  low: 6, // observation / low-acuity
};

// Nursing assistants cover roughly half as many direct care encounters; so
// "assistant density" uses the nurse ratio x 0.5 (i.e., 1 assistant handles
// roughly as many patients as 2 nurses combined).
export const DEFAULT_ASSISTANT_RATIO_MULTIPLIER = 0.5;

const REVIEW_DISCLAIMER =
  'House supervisor review required — decision support only; the module never dispatches staff automatically.';

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

function toNonNegativeInt(value) {
  const n = toNumber(value, 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
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

function toNullableTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeRecommendation(value) {
  const text = cleanText(value).toLowerCase();
  return RECOMMENDATIONS.has(text) ? text : 'unknown';
}

function normalizeSeverity(value) {
  const text = cleanText(value).toLowerCase();
  return SEVERITIES.has(text) ? text : 'unknown';
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Compute the weighted acuity load for a unit.
 *
 *   critical * 4 + high * 2 + moderate * 1.25 + low * 1
 *
 * Negative counts are treated as 0. Empty/missing census returns 0. Rounded
 * to 2dp.
 */
export function computeAcuityLoad({ census = {} } = {}) {
  const c = census && typeof census === 'object' ? census : {};
  const critical = toNonNegativeInt(c.critical);
  const high = toNonNegativeInt(c.high);
  const moderate = toNonNegativeInt(c.moderate);
  const low = toNonNegativeInt(c.low);
  const load = critical * 4 + high * 2 + moderate * 1.25 + low * 1;
  return roundTo(load, 2);
}

/**
 * Compute required nursing + nursing-assistant headcount from the census
 * using role-based ratios. Missing census levels treated as 0. Minimum of
 * 1 each when census_total > 0.
 */
export function computeRequiredStaff({
  census = {},
  nurseRatios = DEFAULT_NURSE_RATIOS,
  assistantMultiplier = DEFAULT_ASSISTANT_RATIO_MULTIPLIER,
} = {}) {
  const c = census && typeof census === 'object' ? census : {};
  const ratios = nurseRatios && typeof nurseRatios === 'object' ? nurseRatios : DEFAULT_NURSE_RATIOS;
  const multiplier = Number.isFinite(Number(assistantMultiplier))
    ? Number(assistantMultiplier)
    : DEFAULT_ASSISTANT_RATIO_MULTIPLIER;

  const levels = ['critical', 'high', 'moderate', 'low'];
  let total = 0;
  let nurse = 0;
  for (const level of levels) {
    const count = toNonNegativeInt(c[level]);
    total += count;
    if (count === 0) continue;
    const ratio = Number(ratios[level]) > 0 ? Number(ratios[level]) : DEFAULT_NURSE_RATIOS[level];
    nurse += Math.ceil(count / ratio);
  }

  let nursing_assistant = Math.ceil(nurse * multiplier);

  if (total > 0) {
    if (nurse < 1) nurse = 1;
    if (nursing_assistant < 1) nursing_assistant = 1;
  } else {
    nurse = 0;
    nursing_assistant = 0;
  }

  return { nurse, nursing_assistant };
}

/**
 * Compute deficit per role. Positive = deficit; negative = surplus.
 *
 * total = sum of positive-only per-role deficits (surpluses excluded).
 */
export function computeDeficit({ required = {}, current = {} } = {}) {
  const req = required && typeof required === 'object' ? required : {};
  const cur = current && typeof current === 'object' ? current : {};

  const nurseReq = toNumber(req.nurse, 0);
  const naReq = toNumber(req.nursing_assistant, 0);
  const nurseCur = toNumber(cur.nurse, 0);
  const naCur = toNumber(cur.nursing_assistant, 0);

  const nurse = nurseReq - nurseCur;
  const nursing_assistant = naReq - naCur;
  const total = Math.max(0, nurse) + Math.max(0, nursing_assistant);

  return { nurse, nursing_assistant, total };
}

/**
 * Forecast peak census during the shift. Peak = max(current, current +
 * admissions - discharges). Negative result clamped to 0.
 */
export function forecastPeakCensus({
  censusTotal = 0,
  predictedAdmissions = 0,
  predictedDischarges = 0,
} = {}) {
  const current = toNumber(censusTotal, 0);
  const admits = toNumber(predictedAdmissions, 0);
  const discharges = toNumber(predictedDischarges, 0);
  const projected = current + admits - discharges;
  const peak = Math.max(current, projected);
  return Math.max(0, peak);
}

/**
 * Classify overall deficit into a band:
 *   deficitTotal < 0  -> 'surplus'
 *   ratio < 0.05      -> 'balanced' (zero deficit lands here)
 *   ratio < 0.15      -> 'watch'
 *   ratio < 0.30      -> 'warning'
 *   ratio >= 0.30     -> 'crisis'
 */
export function classifyDeficitBand({ deficitTotal = 0, censusTotal = 0 } = {}) {
  const deficit = toNumber(deficitTotal, 0);
  const census = Math.max(1, toNumber(censusTotal, 0));
  if (deficit < 0) return 'surplus';
  const ratio = deficit / census;
  if (ratio < 0.05) return 'balanced';
  if (ratio < 0.15) return 'watch';
  if (ratio < 0.30) return 'warning';
  return 'crisis';
}

/**
 * Given a census + current staff snapshot, composes acuity load, peak
 * census, required staff, deficit/band, and a rule-based recommendation.
 *
 * Returns { recommendation, severity, signals, acuity_load, peak_census,
 *           required_staff, deficit_by_role, total_deficit }
 */
export function classifyAcuityStaffing({
  census = {},
  current = {},
  predictedAdmissions = 0,
  predictedDischarges = 0,
  customRatios = null,
} = {}) {
  const c = census && typeof census === 'object' ? census : {};
  const cur = current && typeof current === 'object' ? current : {};

  const critical = toNonNegativeInt(c.critical);
  const high = toNonNegativeInt(c.high);
  const moderate = toNonNegativeInt(c.moderate);
  const low = toNonNegativeInt(c.low);
  const censusTotal = critical + high + moderate + low;

  const acuity_load = computeAcuityLoad({ census: c });
  const peak_census = forecastPeakCensus({
    censusTotal,
    predictedAdmissions,
    predictedDischarges,
  });

  const required_staff = computeRequiredStaff({
    census: c,
    nurseRatios: customRatios && typeof customRatios === 'object'
      ? { ...DEFAULT_NURSE_RATIOS, ...customRatios }
      : DEFAULT_NURSE_RATIOS,
  });

  const deficit_by_role = computeDeficit({ required: required_staff, current: cur });
  const total_deficit = deficit_by_role.total;

  // Derive band: if any role is a surplus and nothing is positive-deficit,
  // treat the unit as overstaffed ('surplus'). Otherwise classify by the
  // positive-only total against census.
  const anyRoleSurplus = (
    deficit_by_role.nurse < 0 || deficit_by_role.nursing_assistant < 0
  );
  const band = total_deficit === 0 && anyRoleSurplus && censusTotal > 0
    ? 'surplus'
    : classifyDeficitBand({ deficitTotal: total_deficit, censusTotal });

  const signals = [];
  let recommendation = 'hold_staffing';
  let severity = 'low';

  const pushSignal = (code, detail) => signals.push({ code, detail });

  // Rules (first match wins). An empty unit short-circuits ahead of the
  // band rules because a zero deficit on a zero census would otherwise
  // register as 'balanced' and mask the empty-unit signal.
  if (censusTotal === 0) {
    recommendation = 'no_action';
    severity = 'low';
    pushSignal('EMPTY_UNIT', 'Unit census is zero; no staffing action required for current census.');
  } else if (critical >= 5 && deficit_by_role.nurse >= 2) {
    recommendation = 'emergency_acuity';
    severity = 'critical';
    pushSignal(
      'CRITICAL_ACUITY_SURGE',
      `Critical-acuity census ${critical} with nurse deficit ${deficit_by_role.nurse}.`
    );
    pushSignal(
      'NURSE_DEFICIT',
      `Nurse deficit ${deficit_by_role.nurse} against required ${required_staff.nurse}.`
    );
  } else if (band === 'crisis') {
    recommendation = 'call_in';
    severity = 'critical';
    pushSignal(
      'NURSING_CRISIS',
      `Total staffing deficit ${total_deficit} against census ${censusTotal} (crisis band).`
    );
  } else if (band === 'warning') {
    recommendation = 'call_in';
    severity = 'high';
    pushSignal(
      'SIGNIFICANT_DEFICIT',
      `Total staffing deficit ${total_deficit} against census ${censusTotal} (warning band).`
    );
  } else if (band === 'watch' && deficit_by_role.nurse >= 1) {
    recommendation = 'float_staff';
    severity = 'moderate';
    pushSignal(
      'MODERATE_DEFICIT',
      `Nurse deficit ${deficit_by_role.nurse} with total deficit ${total_deficit} (watch band).`
    );
  } else if (band === 'surplus' && censusTotal > 0) {
    recommendation = 'reduce_staff';
    severity = 'low';
    pushSignal(
      'STAFF_SURPLUS',
      `Required ${required_staff.nurse} nurses vs current ${toNumber(cur.nurse, 0)} — consider reducing staff for shift.`
    );
  } else if (band === 'balanced') {
    recommendation = 'hold_staffing';
    severity = 'low';
    pushSignal(
      'STAFFING_BALANCED',
      `Staffing balanced against census ${censusTotal}; total deficit ${total_deficit}.`
    );
  } else {
    recommendation = 'hold_staffing';
    severity = 'low';
    pushSignal(
      'DEFAULT_HOLD',
      `No specific rule triggered; holding current staffing (census ${censusTotal}, deficit ${total_deficit}).`
    );
  }

  return {
    recommendation,
    severity,
    signals,
    acuity_load,
    peak_census,
    required_staff,
    deficit_by_role,
    total_deficit,
  };
}

/**
 * Escalate to the highest-priority severity per SEVERITY_PRIORITY. Higher
 * index = more severe.
 */
export function escalateSeverity(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = SEVERITIES.has(entry) ? entry : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Escalate to the highest-priority recommendation per RECOMMENDATION_PRIORITY.
 */
export function escalateRecommendation(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = RECOMMENDATION_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = RECOMMENDATIONS.has(entry) ? entry : 'unknown';
    const idx = RECOMMENDATION_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build a reviewer-facing action list for the supplied recommendation.
 * Always ends with the disclaimer.
 */
export function buildStaffingActions({
  recommendation = 'hold_staffing',
  signals = [],
  unit = null,
} = {}) {
  void signals;
  const rec = normalizeRecommendation(recommendation);
  const unitLabel = cleanText(unit);
  const actions = [];

  switch (rec) {
    case 'emergency_acuity':
      actions.push(
        unitLabel
          ? `Emergency acuity surge on ${unitLabel} — escalate to nursing administration and page critical-care response.`
          : 'Emergency acuity surge — escalate to nursing administration and page critical-care response.'
      );
      actions.push(
        unitLabel
          ? `Call in additional critical-care nurses for ${unitLabel} and confirm intensivist coverage.`
          : 'Call in additional critical-care nurses and confirm intensivist coverage.'
      );
      break;
    case 'call_in':
      actions.push(
        unitLabel
          ? `Call in off-duty nurses for ${unitLabel} via the on-call roster.`
          : 'Call in off-duty nurses via the on-call roster.'
      );
      actions.push(
        unitLabel
          ? `Notify nurse manager covering ${unitLabel} and confirm acceptance before calling.`
          : 'Notify the nurse manager and confirm acceptance before calling.'
      );
      break;
    case 'float_staff':
      actions.push(
        unitLabel
          ? `Page float pool for ${unitLabel} and request redeployment from a lower-acuity unit.`
          : 'Page float pool and request redeployment from a lower-acuity unit.'
      );
      actions.push('Reassess after float staff arrive; escalate to call-in if deficit persists.');
      break;
    case 'reduce_staff':
      actions.push(
        unitLabel
          ? `Offer voluntary low-census time or reassign surplus staff from ${unitLabel} to a higher-acuity unit.`
          : 'Offer voluntary low-census time or reassign surplus staff to a higher-acuity unit.'
      );
      break;
    case 'hold_staffing':
      actions.push(
        unitLabel
          ? `Hold current staffing on ${unitLabel}; monitor census and deficit trending through the shift.`
          : 'Hold current staffing; monitor census and deficit trending through the shift.'
      );
      break;
    case 'no_action':
      actions.push(
        unitLabel
          ? `No staffing action required for ${unitLabel}; unit census is zero.`
          : 'No staffing action required; unit census is zero.'
      );
      break;
    default:
      actions.push('Recommendation unknown — confirm inputs and review with the house supervisor.');
      break;
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence summary for the reviewer / event payload.
 */
export function summarizeStaffingForecast({
  unit = null,
  recommendation = 'hold_staffing',
  severity = 'low',
  totalDeficit = 0,
  censusTotal = 0,
} = {}) {
  const rec = normalizeRecommendation(recommendation);
  const sev = normalizeSeverity(severity);
  const unitLabel = cleanText(unit) || 'unit';
  const deficit = toNumber(totalDeficit, 0);
  const census = toNumber(censusTotal, 0);
  return `Acuity staffing forecast for ${unitLabel}: ${rec} (${sev}) — total deficit ${deficit} across census ${census}.`;
}

// ---------- DB loaders / writers ----------------------------------------

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
      logger.warn('Acuity staffing forecast generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, unit, module }) {
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'HOUSE_SUPERVISOR', 'NURSE_MANAGER'],
        source: 'acuity_staffing_forecast',
        unit: unit || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        approval_policy: module?.settings?.approvalPolicy || 'house_supervisor_review',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Acuity staffing forecast review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeForecastRow(row) {
  if (!row) return row;
  return {
    ...row,
    census_total: toNumber(row.census_total, 0),
    census_critical: toNumber(row.census_critical, 0),
    census_high: toNumber(row.census_high, 0),
    census_moderate: toNumber(row.census_moderate, 0),
    census_low: toNumber(row.census_low, 0),
    predicted_admissions: toNumber(row.predicted_admissions, 0),
    predicted_discharges: toNumber(row.predicted_discharges, 0),
    acuity_load: toNumber(row.acuity_load, 0),
    total_deficit: toNumber(row.total_deficit, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertForecastRow({
  tenantId,
  unit,
  shiftLabel,
  shiftStart,
  shiftEnd,
  generationId,
  census,
  predictedAdmissions,
  predictedDischarges,
  acuityLoad,
  requiredStaff,
  currentStaff,
  deficitByRole,
  totalDeficit,
  recommendation,
  severity,
  signals,
  summary,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  const critical = toNonNegativeInt(census?.critical);
  const high = toNonNegativeInt(census?.high);
  const moderate = toNonNegativeInt(census?.moderate);
  const low = toNonNegativeInt(census?.low);
  const censusTotal = critical + high + moderate + low;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_acuity_staffing_forecasts
         (tenant_id, unit, shift_label, shift_start, shift_end, generation_id,
          census_total, census_critical, census_high, census_moderate, census_low,
          predicted_admissions, predicted_discharges, acuity_load,
          required_staff, current_staff, deficit_by_role, total_deficit,
          recommendation, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6,
               $7, $8, $9, $10, $11,
               $12, $13, $14,
               $15::jsonb, $16::jsonb, $17::jsonb, $18,
               $19, $20, $21::jsonb, $22, $23::jsonb,
               $24::jsonb, $25::jsonb, 'pending', $26::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, unit, shift_label, shift_start, shift_end, generation_id,
                 census_total, census_critical, census_high, census_moderate, census_low,
                 predicted_admissions, predicted_discharges, acuity_load,
                 required_staff, current_staff, deficit_by_role, total_deficit,
                 recommendation, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      unit,
      shiftLabel,
      shiftStart,
      shiftEnd,
      generationId,
      censusTotal,
      critical,
      high,
      moderate,
      low,
      toNonNegativeInt(predictedAdmissions),
      toNonNegativeInt(predictedDischarges),
      toNumber(acuityLoad, 0),
      JSON.stringify(requiredStaff || {}),
      JSON.stringify(currentStaff || {}),
      JSON.stringify(deficitByRole || {}),
      toNumber(totalDeficit, 0),
      RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      JSON.stringify(signals || []),
      summary,
      JSON.stringify(recommendedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeForecastRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateAcuityStaffing({
  req = null,
  unit,
  shiftLabel = null,
  shiftStart = null,
  shiftEnd = null,
  census = {},
  currentStaff = {},
  predictedAdmissions = 0,
  predictedDischarges = 0,
  customRatios = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedUnit = cleanText(unit);
  if (!cleanedUnit) {
    throw AppError.badRequest('unit is required');
  }

  const classification = classifyAcuityStaffing({
    census,
    current: currentStaff,
    predictedAdmissions,
    predictedDischarges,
    customRatios,
  });

  const {
    recommendation,
    severity,
    signals,
    acuity_load,
    peak_census,
    required_staff,
    deficit_by_role,
    total_deficit,
  } = classification;

  const censusCritical = toNonNegativeInt(census?.critical);
  const censusHigh = toNonNegativeInt(census?.high);
  const censusModerate = toNonNegativeInt(census?.moderate);
  const censusLow = toNonNegativeInt(census?.low);
  const censusTotal = censusCritical + censusHigh + censusModerate + censusLow;

  const summary = summarizeStaffingForecast({
    unit: cleanedUnit,
    recommendation,
    severity,
    totalDeficit: total_deficit,
    censusTotal,
  });

  const recommendedActions = buildStaffingActions({
    recommendation,
    signals,
    unit: cleanedUnit,
  });

  const citations = [
    {
      source_type: 'unit_census_snapshot',
      source_id: cleanedUnit,
      label: `Unit census snapshot — ${cleanedUnit}`,
      timestamp: null,
    },
    {
      source_type: 'acuity_staffing_rules',
      source_id: MODULE_KEY,
      label: 'Acuity-based staffing classification rules (nurse 1:2 critical, 1:4 high, 1:5 moderate, 1:6 low)',
      timestamp: null,
    },
  ];
  const uniqueCits = uniqueCitations(citations);

  const safetyFlags = [];
  if (severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'STAFFING_CRITICAL_DEFICIT',
      message: 'Critical staffing deficit or acuity surge detected; house supervisor must review and initiate call-in immediately.',
    });
  }
  if (!uniqueCits.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Acuity staffing forecast has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'ACUITY_STAFFING_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — the module never dispatches staff or modifies the schedule.',
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    unit: cleanedUnit,
    shift_label: shiftLabel,
    recommendation,
    severity,
    acuity_load,
    peak_census,
    required_staff,
    current_staff: currentStaff && typeof currentStaff === 'object' ? currentStaff : {},
    deficit_by_role,
    total_deficit,
    signals,
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
        snapshot_context: {
          unit: cleanedUnit,
          shift_label: shiftLabel,
          census: {
            critical: censusCritical,
            high: censusHigh,
            moderate: censusModerate,
            low: censusLow,
            total: censusTotal,
          },
          current_staff: currentStaff,
          predicted_admissions: toNonNegativeInt(predictedAdmissions),
          predicted_discharges: toNonNegativeInt(predictedDischarges),
        },
        rule_based_evaluation: {
          recommendation,
          severity,
          acuity_load,
          peak_census,
          required_staff,
          deficit_by_role,
          total_deficit,
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
        // Never let AI override rule-based recommendation, severity, required/deficit, or signals.
      };
    }
  } catch (err) {
    logger.debug('Acuity staffing forecast AI narrative unavailable; using rule summary fallback', {
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
        acuity_staffing: {
          unit: cleanedUnit,
          recommendation,
          severity,
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
      unit: cleanedUnit,
      shift_label: shiftLabel,
      census: {
        critical: censusCritical,
        high: censusHigh,
        moderate: censusModerate,
        low: censusLow,
      },
      current_staff: currentStaff,
      predicted_admissions: toNonNegativeInt(predictedAdmissions),
      predicted_discharges: toNonNegativeInt(predictedDischarges),
      recommendation,
      severity,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      unit: cleanedUnit,
      shift_label: shiftLabel,
      recommendation,
      severity,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const forecastRow = await insertForecastRow({
    tenantId,
    unit: cleanedUnit,
    shiftLabel: shiftLabel ? cleanText(shiftLabel) : null,
    shiftStart: toNullableTimestamp(shiftStart),
    shiftEnd: toNullableTimestamp(shiftEnd),
    generationId: generation?.id || null,
    census: {
      critical: censusCritical,
      high: censusHigh,
      moderate: censusModerate,
      low: censusLow,
    },
    predictedAdmissions,
    predictedDischarges,
    acuityLoad: acuity_load,
    requiredStaff: required_staff,
    currentStaff,
    deficitByRole: deficit_by_role,
    totalDeficit: total_deficit,
    recommendation,
    severity,
    signals,
    summary: draft.summary,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      peak_census,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!forecastRow) {
    return {
      forecast_id: null,
      generation_id: generation?.id || null,
      clinical_review_id: null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      recommendation,
      severity,
      signals,
      acuity_load,
      peak_census,
      required_staff,
      deficit_by_role,
      total_deficit,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_acuity_staffing_forecasts_unavailable',
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

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    unit: cleanedUnit,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.acuity_staffing_evaluated',
      aggregateType: 'clinical_ai_acuity_staffing_forecast',
      aggregateId: forecastRow.id,
      payload: {
        tenant_id: tenantId,
        forecast_id: forecastRow.id,
        generation_id: generation?.id || null,
        unit: cleanedUnit,
        shift_label: shiftLabel,
        recommendation,
        severity,
        acuity_load,
        peak_census,
        total_deficit,
        signal_codes: asArray(signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('Acuity staffing forecast event publish failed', { error: err?.message });
  }

  return {
    forecast_id: forecastRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    forecast: forecastRow,
    recommendation,
    severity,
    signals,
    acuity_load,
    peak_census,
    required_staff,
    deficit_by_role,
    total_deficit,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || forecastRow.reviewer_decision || 'pending',
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

export async function listAcuityStaffingForecasts({
  tenantId = null,
  unit = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedUnit = unit ? cleanText(unit) : null;
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
      `SELECT f.id, f.tenant_id, f.unit, f.shift_label, f.shift_start, f.shift_end,
              f.generation_id, f.census_total, f.census_critical, f.census_high,
              f.census_moderate, f.census_low, f.predicted_admissions,
              f.predicted_discharges, f.acuity_load, f.required_staff, f.current_staff,
              f.deficit_by_role, f.total_deficit, f.recommendation, f.severity,
              f.signals, f.summary, f.recommended_actions, f.source_citations,
              f.safety_flags, f.reviewer_decision, f.reviewed_by, f.reviewed_at,
              f.reviewer_note, f.metadata, f.created_at, f.updated_at
       FROM clinical_ai_acuity_staffing_forecasts f
       WHERE f.tenant_id = $1::uuid
         AND ($2::text IS NULL OR f.unit = $2)
         AND ($3::text IS NULL OR f.recommendation = $3)
         AND ($4::text IS NULL OR f.severity = $4)
         AND ($5::text IS NULL OR f.reviewer_decision = $5)
       ORDER BY
         CASE f.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         f.created_at DESC
       LIMIT $6`,
      tid,
      normalizedUnit,
      normalizedRecommendation,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeForecastRow);
    return { forecasts: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { forecasts: [], count: 0 };
    throw err;
  }
}

export async function decideAcuityStaffingForecast({
  tenantId = null,
  forecastId,
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
    `UPDATE clinical_ai_acuity_staffing_forecasts
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, unit, shift_label, shift_start, shift_end, generation_id,
               census_total, census_critical, census_high, census_moderate, census_low,
               predicted_admissions, predicted_discharges, acuity_load,
               required_staff, current_staff, deficit_by_role, total_deficit,
               recommendation, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision, reviewed_by,
               reviewed_at, reviewer_note, metadata, created_at, updated_at`,
    optionalInt(forecastId, 'forecast_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Acuity staffing forecast not found');
  return normalizeForecastRow(rows[0]);
}

export default {
  MODULE_KEY,
  RECOMMENDATIONS,
  RECOMMENDATION_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  DECISIONS,
  FINAL_DECISIONS,
  DEFAULT_NURSE_RATIOS,
  DEFAULT_ASSISTANT_RATIO_MULTIPLIER,
  computeAcuityLoad,
  computeRequiredStaff,
  computeDeficit,
  forecastPeakCensus,
  classifyDeficitBand,
  classifyAcuityStaffing,
  escalateSeverity,
  escalateRecommendation,
  buildStaffingActions,
  summarizeStaffingForecast,
  evaluateAcuityStaffing,
  listAcuityStaffingForecasts,
  decideAcuityStaffingForecast,
};
