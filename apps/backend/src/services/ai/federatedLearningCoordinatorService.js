/**
 * Federated Learning / Privacy-Preserving Training Layer.
 *
 * Governance + coordination layer for federated / privacy-preserving
 * clinical ML training. Registers participating sites (contact,
 * status, last_seen, differential-privacy epsilon budget, min cohort
 * size, accepted aggregation methods) and tracks rounds (participant
 * count, aggregation method, DP ε spent, cohort sizes, data-drift
 * score). Classifies round readiness as
 * `ready` / `hold` / `abort` / `review_privacy` / `no_action`.
 * Rules are authoritative; review-only — AI governance + data
 * engineering approve rounds; the module never triggers training or
 * transmits weights. Coordination + audit only.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'federated_learning_coordinator';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the federated learning / privacy-preserving training coordinator. Rules are authoritative. Return JSON only and never trigger training, transmit weights, or promote a round automatically — AI governance + data engineering review is required for every round.',
  user_prompt_template:
    'Given the round entry, the participating-site list, and the rule-based recommendation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const SITE_STATUSES = new Set([
  'onboarding',
  'active',
  'paused',
  'withdrawn',
  'quarantined',
  'unknown',
]);

export const APPROVAL_STATES = new Set(['pending', 'approved', 'revoked', 'rejected']);

export const AGGREGATION_METHODS = new Set([
  'fed_avg',
  'fed_prox',
  'fed_sgd',
  'secure_avg',
  'differential_fed_avg',
  'unknown',
]);

export const RECOMMENDATIONS = new Set([
  'ready',
  'hold',
  'abort',
  'review_privacy',
  'no_action',
  'unknown',
]);

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

// Priority: higher index = higher priority.
export const RECOMMENDATION_PRIORITY = [
  'unknown',
  'no_action',
  'ready',
  'hold',
  'review_privacy',
  'abort',
];
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'AI governance + data engineering review required — decision support only; the module never triggers training or transmits weights.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
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

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Differential-privacy epsilon utilization percentage.
 *   utilization = spent / max(budget, 0.0001) * 100
 *   clamp to [0, 200], 2 decimals.
 */
export function computeEpsilonUtilization({ spent, budget } = {}) {
  const sp = toNumber(spent, 0);
  const bu = toNumber(budget, 0);
  const denom = Math.max(bu, 0.0001);
  const raw = (sp / denom) * 100;
  const clamped = Math.max(0, Math.min(200, raw));
  return round2(clamped);
}

/**
 * Epsilon utilization band classifier:
 *   null → 'unknown'
 *   < 50 → 'ok'
 *   < 80 → 'watch'
 *   < 100 → 'warning'
 *   >= 100 → 'breach'
 */
export function classifyEpsilonBand(utilizationPct) {
  if (utilizationPct === null || utilizationPct === undefined) return 'unknown';
  const v = toNullableNumber(utilizationPct);
  if (v === null) return 'unknown';
  if (v < 50) return 'ok';
  if (v < 80) return 'watch';
  if (v < 100) return 'warning';
  return 'breach';
}

/**
 * Participant-count band classifier.
 *   participantCount < minParticipants / 2  → 'critical'
 *   participantCount < minParticipants      → 'below_min'
 *   participantCount < minParticipants * 2  → 'ok'
 *   participantCount >= minParticipants * 2 → 'strong'
 */
export function classifyParticipantBand({ participantCount, minParticipants } = {}) {
  const count = toNumber(participantCount, 0);
  const min = toNumber(minParticipants, 0);
  if (count < min / 2) return 'critical';
  if (count < min) return 'below_min';
  if (count < min * 2) return 'ok';
  return 'strong';
}

/**
 * Cohort-size band classifier based on the smallest participating
 * site's cohort size vs the configured floor.
 *   null → 'unknown'
 *   < siteMinFloor / 2 → 'unsafe'
 *   < siteMinFloor     → 'below_floor'
 *   < siteMinFloor * 2 → 'ok'
 *   >= siteMinFloor * 2 → 'strong'
 */
export function classifyCohortBand({ cohortMinSiteSize, siteMinFloor = 100 } = {}) {
  if (cohortMinSiteSize === null || cohortMinSiteSize === undefined) return 'unknown';
  const v = toNullableNumber(cohortMinSiteSize);
  if (v === null) return 'unknown';
  const floor = toNumber(siteMinFloor, 100);
  // Treat the exact half-floor boundary as unsafe — per-round tests
  // expect cohort_min_site_size=50 with floor=100 to fire COHORT_UNSAFE.
  if (v <= floor / 2) return 'unsafe';
  if (v < floor) return 'below_floor';
  if (v < floor * 2) return 'ok';
  return 'strong';
}

/**
 * Data-drift score band classifier.
 *   null → 'unknown'
 *   < 0.1 → 'stable'
 *   < 0.25 → 'watch'
 *   < 0.5 → 'warning'
 *   >= 0.5 → 'breach'
 */
export function classifyDriftBand(dataDriftScore) {
  if (dataDriftScore === null || dataDriftScore === undefined) return 'unknown';
  const v = toNullableNumber(dataDriftScore);
  if (v === null) return 'unknown';
  if (v < 0.1) return 'stable';
  if (v < 0.25) return 'watch';
  if (v < 0.5) return 'warning';
  return 'breach';
}

/**
 * Rules-authoritative federation-round readiness classifier. First
 * matching rule wins.
 *
 * Returns { recommendation, severity, signals: [{ code, detail? }] }.
 */
export function classifyFederationRound({
  participantCount,
  minParticipants,
  epsilonSpent,
  epsilonBudget,
  cohortMinSiteSize,
  siteMinFloor = 100,
  dataDriftScore = null,
  aggregationMethod = 'fed_avg',
} = {}) {
  const epsPct = computeEpsilonUtilization({
    spent: epsilonSpent,
    budget: epsilonBudget,
  });
  const epsilonBand = classifyEpsilonBand(epsPct);
  const participantBand = classifyParticipantBand({
    participantCount,
    minParticipants,
  });
  const cohortBand = classifyCohortBand({
    cohortMinSiteSize,
    siteMinFloor,
  });
  const driftBand = classifyDriftBand(dataDriftScore);
  const method = AGGREGATION_METHODS.has(aggregationMethod) ? aggregationMethod : 'unknown';

  // Rule 1: epsilon breach OR cohort unsafe → abort / critical.
  if (epsilonBand === 'breach' || cohortBand === 'unsafe') {
    const signals = [];
    if (epsilonBand === 'breach') {
      signals.push({
        code: 'PRIVACY_BUDGET_EXCEEDED',
        detail: `epsilon_utilization_pct=${epsPct}`,
      });
    }
    if (cohortBand === 'unsafe') {
      signals.push({
        code: 'COHORT_UNSAFE',
        detail: `cohort_min_site_size=${cohortMinSiteSize}, floor=${siteMinFloor}`,
      });
    }
    return {
      recommendation: 'abort',
      severity: 'critical',
      signals,
    };
  }

  // Rule 2: participant critical → abort / critical.
  if (participantBand === 'critical') {
    return {
      recommendation: 'abort',
      severity: 'critical',
      signals: [{
        code: 'PARTICIPANT_CRITICAL',
        detail: `participant_count=${participantCount}, min=${minParticipants}`,
      }],
    };
  }

  // Rule 3: epsilon warning OR cohort below_floor OR drift breach → review_privacy / high.
  if (
    epsilonBand === 'warning'
    || cohortBand === 'below_floor'
    || driftBand === 'breach'
  ) {
    const signals = [{
      code: 'PRIVACY_RISK',
      detail: `epsilon=${epsilonBand}, cohort=${cohortBand}, drift=${driftBand}`,
    }];
    return {
      recommendation: 'review_privacy',
      severity: 'high',
      signals,
    };
  }

  // Rule 4: participant below_min → hold / high.
  if (participantBand === 'below_min') {
    return {
      recommendation: 'hold',
      severity: 'high',
      signals: [{
        code: 'PARTICIPANT_BELOW_MIN',
        detail: `participant_count=${participantCount}, min=${minParticipants}`,
      }],
    };
  }

  // Rule 5: drift warning → hold / moderate.
  if (driftBand === 'warning') {
    return {
      recommendation: 'hold',
      severity: 'moderate',
      signals: [{
        code: 'DRIFT_WARNING',
        detail: `data_drift_score=${dataDriftScore}`,
      }],
    };
  }

  // Rule 6: everything green → ready / low.
  const participantHealthy = participantBand === 'ok' || participantBand === 'strong';
  const epsilonHealthy = epsilonBand === 'ok' || epsilonBand === 'watch';
  const cohortHealthy = cohortBand === 'ok' || cohortBand === 'strong';
  const driftHealthy = driftBand === 'stable' || driftBand === 'watch' || driftBand === 'unknown';
  if (participantHealthy && epsilonHealthy && cohortHealthy && driftHealthy) {
    return {
      recommendation: 'ready',
      severity: 'low',
      signals: [{
        code: 'ROUND_READY',
        detail: `method=${method}, participants=${participantCount}, epsilon_pct=${epsPct}`,
      }],
    };
  }

  // Rule 7: insufficient data / unclear state.
  return {
    recommendation: 'no_action',
    severity: 'low',
    signals: [{ code: 'INSUFFICIENT_DATA' }],
  };
}

/**
 * Escalate a list of severities to the highest per SEVERITY_PRIORITY.
 */
export function escalateSeverity(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of arr) {
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
 * Escalate a list of recommendations to the highest per RECOMMENDATION_PRIORITY.
 */
export function escalateRecommendation(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = RECOMMENDATION_PRIORITY.indexOf('unknown');
  for (const rec of arr) {
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
 * Build reviewer-facing action lines for a given recommendation. Always
 * ends with the AI-governance + data-engineering disclaimer.
 */
export function buildFederationActions({
  recommendation,
  signals = [],
  roundKey = null,
  modelKey = null,
} = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  const roundLabel = cleanText(roundKey) || 'this round';
  const modelLabel = cleanText(modelKey) || 'this model';

  switch (recommendation) {
    case 'abort':
      push(`Abort ${roundLabel} for ${modelLabel} — halt coordination and notify AI governance immediately.`);
      push('Do not re-attempt this round until the failing privacy or cohort signal is resolved and re-reviewed.');
      push('Open an incident ticket capturing the privacy budget and cohort snapshot that triggered the abort.');
      break;
    case 'review_privacy':
      push(`Route ${roundLabel} (${modelLabel}) to the privacy reviewer — differential-privacy budget or cohort floor is at risk.`);
      push('Have data engineering confirm per-site ε spent and cohort membership before the round proceeds.');
      push('Do not advance the round until the privacy reviewer signs off in writing.');
      break;
    case 'hold':
      push(`Hold ${roundLabel} (${modelLabel}) — participant count or drift warrants investigation before aggregation.`);
      push('Contact the missing sites or rerun the drift canary with a fresh reference window.');
      break;
    case 'ready':
      push(`Queue ${roundLabel} (${modelLabel}) for AI governance + data engineering sign-off — rule checks passed.`);
      push('Confirm each participating site has an active approval and the aggregation method is on their accepted list.');
      break;
    case 'no_action':
    default:
      push(`No coordination action recommended for ${roundLabel} (${modelLabel}); continue routine monitoring.`);
      break;
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'PRIVACY_BUDGET_EXCEEDED') {
      push('Reset or renegotiate the per-site DP epsilon budget before any further aggregation.');
    } else if (code === 'COHORT_UNSAFE') {
      push('Exclude or pause sites whose cohort size is below the safety floor and recompute the round.');
    } else if (code === 'PARTICIPANT_CRITICAL' || code === 'PARTICIPANT_BELOW_MIN') {
      push('Confirm onboarding and approvals for the missing sites before re-running the round.');
    } else if (code === 'PRIVACY_RISK') {
      push('Tighten the DP noise profile or switch to a privacy-preserving aggregation method.');
    } else if (code === 'DRIFT_WARNING') {
      push('Capture a drift-report snapshot and compare against the previous accepted round reference window.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary of a federation round.
 */
export function summarizeFederationRound({
  roundKey,
  modelKey,
  recommendation,
  severity,
  participantCount,
  epsilonSpent,
} = {}) {
  const round = cleanText(roundKey) || 'round';
  const model = cleanText(modelKey) || 'model';
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const part = participantCount === null || participantCount === undefined
    ? 'n/a'
    : toNumber(participantCount, 0);
  const eps = epsilonSpent === null || epsilonSpent === undefined
    ? 'n/a'
    : toNumber(epsilonSpent, 0);
  return `${round} (${model}): ${rec} (${sev}) — participants=${part}, epsilon_spent=${eps}.`;
}

// ---------- DB helpers --------------------------------------------------

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

function normalizeSiteRow(row) {
  if (!row) return row;
  return {
    ...row,
    dp_epsilon_budget: row.dp_epsilon_budget !== null && row.dp_epsilon_budget !== undefined
      ? toNumber(row.dp_epsilon_budget, null)
      : null,
    dp_epsilon_spent: row.dp_epsilon_spent !== null && row.dp_epsilon_spent !== undefined
      ? toNumber(row.dp_epsilon_spent, null)
      : null,
    min_cohort_size: row.min_cohort_size !== null && row.min_cohort_size !== undefined
      ? toNumber(row.min_cohort_size, null)
      : null,
  };
}

function normalizeRoundRow(row) {
  if (!row) return row;
  return {
    ...row,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    participant_site_count: row.participant_site_count !== null && row.participant_site_count !== undefined
      ? toNumber(row.participant_site_count, 0)
      : 0,
    min_participants: row.min_participants !== null && row.min_participants !== undefined
      ? toNumber(row.min_participants, 0)
      : 0,
    total_dp_epsilon_spent: row.total_dp_epsilon_spent !== null && row.total_dp_epsilon_spent !== undefined
      ? toNumber(row.total_dp_epsilon_spent, null)
      : null,
    cohort_total_size: row.cohort_total_size !== null && row.cohort_total_size !== undefined
      ? toNumber(row.cohort_total_size, 0)
      : 0,
    cohort_min_site_size: row.cohort_min_site_size !== null && row.cohort_min_site_size !== undefined
      ? toNumber(row.cohort_min_site_size, null)
      : null,
    data_drift_score: row.data_drift_score !== null && row.data_drift_score !== undefined
      ? toNumber(row.data_drift_score, null)
      : null,
  };
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
      logger.warn('Federation coordinator generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module, roundKey, modelKey }) {
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE', 'DATA_ENGINEER'],
        source: 'federated_learning_coordinator',
        round_key: roundKey || null,
        model_key: modelKey || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
        no_training_execution: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Federation coordinator review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Insert or update a federation-site row by (tenant_id, site_key).
 * Does NOT overwrite status or approval_status — those are managed by
 * changeSiteStatus().
 */
export async function upsertFederationSite({
  tenantId = null,
  siteKey,
  displayName = null,
  region = null,
  contact = null,
  dpEpsilonBudget = null,
  dpEpsilonSpent = null,
  minCohortSize = null,
  acceptedAggregationMethods = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const key = cleanText(siteKey);
  if (!key) throw AppError.badRequest('site_key is required');

  const budget = toNullableNumber(dpEpsilonBudget);
  const spent = toNullableNumber(dpEpsilonSpent);
  const cohort = minCohortSize === null || minCohortSize === undefined
    ? null
    : toNullableNumber(minCohortSize);
  const methods = Array.isArray(acceptedAggregationMethods)
    ? acceptedAggregationMethods
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_federation_sites
         (tenant_id, site_key, display_name, region, contact,
          dp_epsilon_budget, dp_epsilon_spent, min_cohort_size,
          accepted_aggregation_methods, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5,
               COALESCE($6, 10.0000), COALESCE($7, 0.0000), COALESCE($8, 100),
               COALESCE($9::jsonb, '["fed_avg"]'::jsonb), $10::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, site_key)
       DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, clinical_ai_federation_sites.display_name),
         region = COALESCE(EXCLUDED.region, clinical_ai_federation_sites.region),
         contact = COALESCE(EXCLUDED.contact, clinical_ai_federation_sites.contact),
         dp_epsilon_budget = COALESCE($6, clinical_ai_federation_sites.dp_epsilon_budget),
         dp_epsilon_spent = COALESCE($7, clinical_ai_federation_sites.dp_epsilon_spent),
         min_cohort_size = COALESCE($8, clinical_ai_federation_sites.min_cohort_size),
         accepted_aggregation_methods = COALESCE($9::jsonb, clinical_ai_federation_sites.accepted_aggregation_methods),
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, site_key, display_name, region, contact, status,
                 dp_epsilon_budget, dp_epsilon_spent, min_cohort_size,
                 accepted_aggregation_methods, last_seen_at, approval_status,
                 approval_note, approved_by, approved_at, metadata,
                 created_at, updated_at`,
      tid,
      key,
      displayName ? cleanText(displayName) : null,
      region ? cleanText(region) : null,
      contact ? cleanText(contact) : null,
      budget,
      spent,
      cohort,
      methods ? JSON.stringify(methods) : null,
      JSON.stringify(metadata || {})
    );
    return normalizeSiteRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List federation-site rows for the tenant. Filter by siteKey, status,
 * approvalStatus, region. Limit 1..200.
 */
export async function listFederationSites({
  tenantId = null,
  siteKey = null,
  status = null,
  approvalStatus = null,
  region = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedKey = siteKey ? cleanText(siteKey) : null;
  const normalizedStatus = status && SITE_STATUSES.has(cleanText(status).toLowerCase())
    ? cleanText(status).toLowerCase()
    : null;
  const normalizedApproval = approvalStatus
    && APPROVAL_STATES.has(cleanText(approvalStatus).toLowerCase())
    ? cleanText(approvalStatus).toLowerCase()
    : null;
  const normalizedRegion = region ? cleanText(region) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, site_key, display_name, region, contact, status,
              dp_epsilon_budget, dp_epsilon_spent, min_cohort_size,
              accepted_aggregation_methods, last_seen_at, approval_status,
              approval_note, approved_by, approved_at, metadata,
              created_at, updated_at
       FROM clinical_ai_federation_sites
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR site_key = $2)
         AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR approval_status = $4)
         AND ($5::text IS NULL OR region = $5)
       ORDER BY site_key ASC, created_at DESC
       LIMIT $6`,
      tid,
      normalizedKey,
      normalizedStatus,
      normalizedApproval,
      normalizedRegion,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeSiteRow);
    return { sites: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { sites: [], count: 0 };
    throw err;
  }
}

/**
 * Change site lifecycle status and/or approval status.
 */
export async function changeSiteStatus({
  tenantId = null,
  siteId,
  status,
  approvalStatus = null,
  approvalNote = null,
  approvedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = optionalInt(siteId, 'site_id');
  const normalizedStatus = cleanText(status).toLowerCase();
  if (!SITE_STATUSES.has(normalizedStatus)) {
    throw AppError.badRequest(`status must be one of: ${Array.from(SITE_STATUSES).join(', ')}`);
  }
  const normalizedApproval = approvalStatus ? cleanText(approvalStatus).toLowerCase() : null;
  if (normalizedApproval && !APPROVAL_STATES.has(normalizedApproval)) {
    throw AppError.badRequest(`approval_status must be one of: ${Array.from(APPROVAL_STATES).join(', ')}`);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_federation_sites
     SET status = $2,
         approval_status = COALESCE($3, approval_status),
         approval_note = COALESCE($4, approval_note),
         approved_by = COALESCE($5::uuid, approved_by),
         approved_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE approved_at END,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $6::uuid
     RETURNING id, tenant_id, site_key, display_name, region, contact, status,
               dp_epsilon_budget, dp_epsilon_spent, min_cohort_size,
               accepted_aggregation_methods, last_seen_at, approval_status,
               approval_note, approved_by, approved_at, metadata,
               created_at, updated_at`,
    id,
    normalizedStatus,
    normalizedApproval,
    approvalNote ? cleanText(approvalNote) : null,
    approvedBy || null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Federation site not found');
  return normalizeSiteRow(rows[0]);
}

/**
 * Record a federation round and produce a rules-authoritative readiness
 * recommendation.
 */
export async function recordFederationRound({
  req = null,
  roundKey,
  modelKey,
  aggregationMethod = 'fed_avg',
  startedAt = null,
  endedAt = null,
  participantSiteCount = 0,
  minParticipants = 3,
  totalDpEpsilonSpent = 0,
  totalDpEpsilonBudget = 10,
  cohortTotalSize = 0,
  cohortMinSiteSize = null,
  siteMinFloor = 100,
  dataDriftScore = null,
  siteParticipation = [],
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  // Validate inputs.
  const round = cleanText(roundKey);
  if (!round) throw AppError.badRequest('round_key is required');
  const model = cleanText(modelKey);
  if (!model) throw AppError.badRequest('model_key is required');
  const method = cleanText(aggregationMethod).toLowerCase();
  if (!AGGREGATION_METHODS.has(method)) {
    throw AppError.badRequest(
      `aggregation_method must be one of: ${Array.from(AGGREGATION_METHODS).join(', ')}`
    );
  }

  // Coerce numeric inputs.
  const partCount = toNumber(participantSiteCount, 0);
  const minPart = toNumber(minParticipants, 0);
  const epsSpent = toNumber(totalDpEpsilonSpent, 0);
  const epsBudget = toNumber(totalDpEpsilonBudget, 0);
  const totalCohort = toNumber(cohortTotalSize, 0);
  const minCohort = toNullableNumber(cohortMinSiteSize);
  const floor = toNumber(siteMinFloor, 100);
  const drift = toNullableNumber(dataDriftScore);
  const participationList = asArray(siteParticipation);

  // Classification.
  const classification = classifyFederationRound({
    participantCount: partCount,
    minParticipants: minPart,
    epsilonSpent: epsSpent,
    epsilonBudget: epsBudget,
    cohortMinSiteSize: minCohort,
    siteMinFloor: floor,
    dataDriftScore: drift,
    aggregationMethod: method,
  });

  const summary = summarizeFederationRound({
    roundKey: round,
    modelKey: model,
    recommendation: classification.recommendation,
    severity: classification.severity,
    participantCount: partCount,
    epsilonSpent: epsSpent,
  });
  const recommendedActions = buildFederationActions({
    recommendation: classification.recommendation,
    signals: classification.signals,
    roundKey: round,
    modelKey: model,
  });

  // Citations: per participating site ref + federation rules reference.
  const citations = [];
  for (const entry of participationList) {
    if (!entry) continue;
    const siteKey = cleanText(entry.site_key || entry.siteKey || '');
    if (!siteKey) continue;
    citations.push({
      source_type: 'federation_site',
      source_id: siteKey,
      label: `Federation site — ${siteKey}`,
      timestamp: entry.last_seen_at || entry.lastSeenAt || null,
    });
  }
  citations.push({
    source_type: 'federation_rules',
    source_id: MODULE_KEY,
    label: 'Federation coordination rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'FEDERATION_ROUND_CRITICAL',
      message: `Recommendation '${classification.recommendation}' — immediate AI governance + data engineering attention required.`,
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Federation round has no source citations.',
    });
  }

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    round_key: round,
    model_key: model,
    aggregation_method: method,
    metrics: {
      participant_site_count: partCount,
      min_participants: minPart,
      total_dp_epsilon_spent: epsSpent,
      total_dp_epsilon_budget: epsBudget,
      cohort_total_size: totalCohort,
      cohort_min_site_size: minCohort,
      site_min_floor: floor,
      data_drift_score: drift,
    },
    site_participation: participationList,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
    no_training_execution: true,
  };

  // Optional AI narrative (decorative only — never overrides rules).
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        round: {
          round_key: round,
          model_key: model,
          aggregation_method: method,
          started_at: startedAt,
          ended_at: endedAt,
        },
        metrics: fallbackDraft.metrics,
        site_participation: participationList,
        rule_based_evaluation: {
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
      };
    }
  } catch (err) {
    logger.debug('Federation coordinator AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  // Merge with output defenses.
  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        round: { key: round, model_key: model },
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  // Persist generation.
  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      round_key: round,
      model_key: model,
      aggregation_method: method,
      participant_site_count: partCount,
      total_dp_epsilon_spent: epsSpent,
      recommendation: classification.recommendation,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      round_key: round,
      model_key: model,
      aggregation_method: method,
      recommendation: classification.recommendation,
      severity: classification.severity,
      signal_codes: classification.signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
      no_training_execution: true,
    },
  });

  // Persist round row.
  let roundRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_federation_rounds
         (tenant_id, round_key, model_key, aggregation_method,
          started_at, ended_at, participant_site_count, min_participants,
          total_dp_epsilon_spent, cohort_total_size, cohort_min_site_size,
          data_drift_score, site_participation, generation_id,
          recommendation, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4,
               $5::timestamptz, $6::timestamptz, $7, $8,
               $9, $10, $11,
               $12, $13::jsonb, $14,
               $15, $16, $17::jsonb, $18, $19::jsonb,
               $20::jsonb, $21::jsonb, 'pending', $22::jsonb,
               NOW(), NOW())
       ON CONFLICT (tenant_id, round_key, model_key)
       DO UPDATE SET
         aggregation_method = EXCLUDED.aggregation_method,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         participant_site_count = EXCLUDED.participant_site_count,
         min_participants = EXCLUDED.min_participants,
         total_dp_epsilon_spent = EXCLUDED.total_dp_epsilon_spent,
         cohort_total_size = EXCLUDED.cohort_total_size,
         cohort_min_site_size = EXCLUDED.cohort_min_site_size,
         data_drift_score = EXCLUDED.data_drift_score,
         site_participation = EXCLUDED.site_participation,
         generation_id = EXCLUDED.generation_id,
         recommendation = EXCLUDED.recommendation,
         severity = EXCLUDED.severity,
         signals = EXCLUDED.signals,
         summary = EXCLUDED.summary,
         recommended_actions = EXCLUDED.recommended_actions,
         source_citations = EXCLUDED.source_citations,
         safety_flags = EXCLUDED.safety_flags,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, round_key, model_key, aggregation_method,
                 started_at, ended_at, participant_site_count, min_participants,
                 total_dp_epsilon_spent, cohort_total_size, cohort_min_site_size,
                 data_drift_score, site_participation, generation_id,
                 recommendation, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at,
                 retention_until`,
      tenantId,
      round,
      model,
      method,
      startedAt || null,
      endedAt || null,
      partCount,
      minPart,
      epsSpent,
      totalCohort,
      minCohort,
      drift,
      JSON.stringify(participationList),
      generation?.id || null,
      RECOMMENDATIONS.has(classification.recommendation) ? classification.recommendation : 'unknown',
      SEVERITIES.has(classification.severity) ? classification.severity : 'unknown',
      JSON.stringify(asArray(classification.signals)),
      draft.summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(draft.source_citations)),
      JSON.stringify(asArray(combinedFlags)),
      JSON.stringify(metadata || {})
    );
    roundRow = normalizeRoundRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        round_id: null,
        generation_id: generation?.id || null,
        draft,
        source_citations: draft.source_citations,
        safety_flags: combinedFlags,
        recommendation: classification.recommendation,
        severity: classification.severity,
        signals: classification.signals,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_federation_rounds_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      };
    }
    throw err;
  }

  // Review placeholder.
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
    roundKey: round,
    modelKey: model,
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.federation_round_recorded',
      aggregateType: 'clinical_ai_federation_round',
      aggregateId: roundRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        round_id: roundRow.id,
        generation_id: generation?.id || null,
        round_key: round,
        model_key: model,
        aggregation_method: method,
        recommendation: classification.recommendation,
        severity: classification.severity,
        signal_codes: classification.signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Federation coordinator event publish failed', { error: err?.message });
  }

  return {
    round_id: roundRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    round: roundRow,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || roundRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

/**
 * List federation-round rows for the tenant. Severity-sorted
 * (critical first), then created_at DESC.
 */
export async function listFederationRounds({
  tenantId = null,
  roundKey = null,
  modelKey = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedRound = roundKey ? cleanText(roundKey) : null;
  const normalizedModel = modelKey ? cleanText(modelKey) : null;
  const normalizedRec = recommendation
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
      `SELECT r.id, r.tenant_id, r.round_key, r.model_key, r.aggregation_method,
              r.started_at, r.ended_at, r.participant_site_count, r.min_participants,
              r.total_dp_epsilon_spent, r.cohort_total_size, r.cohort_min_site_size,
              r.data_drift_score, r.site_participation, r.generation_id,
              r.recommendation, r.severity, r.signals, r.summary, r.recommended_actions,
              r.source_citations, r.safety_flags, r.reviewer_decision, r.reviewed_by,
              r.reviewed_at, r.reviewer_note, r.metadata, r.created_at, r.updated_at,
              r.retention_until
       FROM clinical_ai_federation_rounds r
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.round_key = $2)
         AND ($3::text IS NULL OR r.model_key = $3)
         AND ($4::text IS NULL OR r.recommendation = $4)
         AND ($5::text IS NULL OR r.severity = $5)
         AND ($6::text IS NULL OR r.reviewer_decision = $6)
       ORDER BY
         CASE r.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $7`,
      tid,
      normalizedRound,
      normalizedModel,
      normalizedRec,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeRoundRow);
    return { rounds: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rounds: [], count: 0 };
    throw err;
  }
}

/**
 * Record an AI governance + data engineering decision on a
 * federation-round row.
 */
export async function decideFederationRound({
  tenantId = null,
  roundId,
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
    `UPDATE clinical_ai_federation_rounds
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, round_key, model_key, aggregation_method,
               started_at, ended_at, participant_site_count, min_participants,
               total_dp_epsilon_spent, cohort_total_size, cohort_min_site_size,
               data_drift_score, site_participation, generation_id,
               recommendation, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision, reviewed_by,
               reviewed_at, reviewer_note, metadata, created_at, updated_at,
               retention_until`,
    optionalInt(roundId, 'round_id'),
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Federation round not found');
  return normalizeRoundRow(rows[0]);
}

export default {
  SITE_STATUSES,
  APPROVAL_STATES,
  AGGREGATION_METHODS,
  RECOMMENDATIONS,
  SEVERITIES,
  RECOMMENDATION_PRIORITY,
  SEVERITY_PRIORITY,
  computeEpsilonUtilization,
  classifyEpsilonBand,
  classifyParticipantBand,
  classifyCohortBand,
  classifyDriftBand,
  classifyFederationRound,
  escalateSeverity,
  escalateRecommendation,
  buildFederationActions,
  summarizeFederationRound,
  upsertFederationSite,
  listFederationSites,
  changeSiteStatus,
  recordFederationRound,
  listFederationRounds,
  decideFederationRound,
};
