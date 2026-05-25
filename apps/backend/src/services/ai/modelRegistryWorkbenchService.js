/**
 * Model Registry and Evaluation Workbench.
 *
 * Tracks every AI model variant used by the platform (name, version,
 * provider, lineage, purpose, owner, approval stage) and records
 * eval-run results (metrics snapshot per canary suite or regression
 * run). Recommends a lifecycle stage (sandbox / staging / production /
 * deprecated / quarantined) based on latency, fallback rate, accuracy/F1,
 * safety-flag rate, and drift score deltas. Governance / AI-eval-lead
 * approves promotions and retirements. Review-only — never automatically
 * promotes or retires a model.
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

const MODULE_KEY = 'model_registry_workbench';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the AI model registry and evaluation workbench. Rules are authoritative. Return JSON only and never change a model stage automatically — AI eval lead review is required for every promotion or retirement.',
  user_prompt_template:
    'Given the model, the latest eval-run metrics, and the rule-based recommendation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const STAGES = new Set([
  'sandbox',
  'staging',
  'production',
  'deprecated',
  'quarantined',
  'unknown',
]);

export const APPROVAL_STATES = new Set([
  'pending',
  'approved',
  'revoked',
  'rejected',
  'pending_retirement',
]);

export const RECOMMENDATIONS = new Set([
  'promote',
  'hold',
  'rollback',
  'retire',
  'no_action',
  'quarantine',
  'unknown',
]);

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

// Priority: higher index = higher priority.
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const RECOMMENDATION_PRIORITY = [
  'unknown',
  'no_action',
  'hold',
  'retire',
  'promote',
  'rollback',
  'quarantine',
];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'AI eval lead review required — decision support only; model stage is never changed automatically.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
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
 * Percentage of numerator vs denominator, clamped 0..100, 2 decimals.
 *   denominator <= 0 → 0
 */
export function computeRate({ numerator, denominator } = {}) {
  const num = toNumber(numerator, 0);
  const den = toNumber(denominator, 0);
  if (den <= 0) return 0;
  const raw = (num / den) * 100;
  const clamped = Math.max(0, Math.min(100, raw));
  return round2(clamped);
}

/**
 * Absolute and percent delta between current and previous.
 *   previous === 0 → delta_pct = 0
 *   null inputs treated as 0
 */
export function computeDelta({ current, previous } = {}) {
  const cur = toNumber(current, 0);
  const prev = toNumber(previous, 0);
  const delta = cur - prev;
  if (prev === 0) {
    return { delta: round2(delta), delta_pct: 0 };
  }
  const pct = (delta / prev) * 100;
  return { delta: round2(delta), delta_pct: round2(pct) };
}

/**
 * Latency band classifier:
 *   null → 'unknown'
 *   < 500  → 'fast'
 *   < 1500 → 'acceptable'
 *   < 3000 → 'slow'
 *   >=3000 → 'breach'
 */
export function classifyLatencyBand(avgLatencyMs) {
  if (avgLatencyMs === null || avgLatencyMs === undefined) return 'unknown';
  const v = toNullableNumber(avgLatencyMs);
  if (v === null) return 'unknown';
  if (v < 500) return 'fast';
  if (v < 1500) return 'acceptable';
  if (v < 3000) return 'slow';
  return 'breach';
}

/**
 * Fallback rate band classifier (pct 0..100):
 *   null → 'unknown'
 *   < 1  → 'ok'
 *   < 5  → 'watch'
 *   < 15 → 'warning'
 *   >=15 → 'breach'
 */
export function classifyFallbackBand(pct) {
  if (pct === null || pct === undefined) return 'unknown';
  const v = toNullableNumber(pct);
  if (v === null) return 'unknown';
  if (v < 1) return 'ok';
  if (v < 5) return 'watch';
  if (v < 15) return 'warning';
  return 'breach';
}

/**
 * Safety-flag rate band classifier (pct 0..100):
 *   null → 'unknown'
 *   < 0.5 → 'ok'
 *   < 2   → 'watch'
 *   < 5   → 'warning'
 *   >=5   → 'breach'
 */
export function classifySafetyFlagBand(pct) {
  if (pct === null || pct === undefined) return 'unknown';
  const v = toNullableNumber(pct);
  if (v === null) return 'unknown';
  if (v < 0.5) return 'ok';
  if (v < 2) return 'watch';
  if (v < 5) return 'warning';
  return 'breach';
}

/**
 * Accuracy band classifier (0..1):
 *   null → 'unknown'
 *   >= 0.95 → 'excellent'
 *   >= 0.90 → 'good'
 *   >= 0.80 → 'acceptable'
 *   <  0.80 → 'poor'
 */
export function classifyAccuracyBand(acc) {
  if (acc === null || acc === undefined) return 'unknown';
  const v = toNullableNumber(acc);
  if (v === null) return 'unknown';
  if (v >= 0.95) return 'excellent';
  if (v >= 0.9) return 'good';
  if (v >= 0.8) return 'acceptable';
  return 'poor';
}

/**
 * Drift score band classifier:
 *   null → 'unknown'
 *   < 0.05 → 'stable'
 *   < 0.15 → 'watch'
 *   < 0.3  → 'warning'
 *   >=0.3  → 'breach'
 */
export function classifyDriftBand(drift) {
  if (drift === null || drift === undefined) return 'unknown';
  const v = toNullableNumber(drift);
  if (v === null) return 'unknown';
  if (v < 0.05) return 'stable';
  if (v < 0.15) return 'watch';
  if (v < 0.3) return 'warning';
  return 'breach';
}

/**
 * Rules-authoritative eval recommendation. First match wins.
 *
 *   current: { accuracy, f1_score, avg_latency_ms, fallback_rate_pct,
 *              safety_flag_rate_pct, drift_score }
 *   baseline: optional { accuracy, f1_score, ... } — used only for
 *             regression + promote rules.
 *
 * Returns { recommendation, severity, signals: [{ code, detail? }] }.
 */
export function classifyEvalRecommendation({ current = {}, baseline = null } = {}) {
  const latencyBand = classifyLatencyBand(current.avg_latency_ms);
  const fallbackBand = classifyFallbackBand(current.fallback_rate_pct);
  const safetyBand = classifySafetyFlagBand(current.safety_flag_rate_pct);
  const accuracyBand = classifyAccuracyBand(current.accuracy);
  const driftBand = classifyDriftBand(current.drift_score);

  // Rule 1: ANY breach across latency/fallback/safety → quarantine/critical.
  const breachSignals = [];
  if (latencyBand === 'breach') {
    breachSignals.push({ code: 'LATENCY_BREACH', detail: `avg_latency_ms=${current.avg_latency_ms}` });
  }
  if (fallbackBand === 'breach') {
    breachSignals.push({ code: 'FALLBACK_BREACH', detail: `fallback_rate_pct=${current.fallback_rate_pct}` });
  }
  if (safetyBand === 'breach') {
    breachSignals.push({ code: 'SAFETY_FLAG_BREACH', detail: `safety_flag_rate_pct=${current.safety_flag_rate_pct}` });
  }
  if (breachSignals.length) {
    return {
      recommendation: 'quarantine',
      severity: 'critical',
      signals: breachSignals,
    };
  }

  // Rule 2: accuracy 'poor' OR drift 'breach' → rollback/high.
  if (accuracyBand === 'poor') {
    return {
      recommendation: 'rollback',
      severity: 'high',
      signals: [{ code: 'ACCURACY_POOR', detail: `accuracy=${current.accuracy}` }],
    };
  }
  if (driftBand === 'breach') {
    return {
      recommendation: 'rollback',
      severity: 'high',
      signals: [{ code: 'DRIFT_BREACH', detail: `drift_score=${current.drift_score}` }],
    };
  }

  // Rule 3: safety 'warning' OR fallback 'warning' → hold/moderate.
  if (safetyBand === 'warning' || fallbackBand === 'warning') {
    return {
      recommendation: 'hold',
      severity: 'moderate',
      signals: [{
        code: 'ELEVATED_RATES',
        detail: `safety=${safetyBand}, fallback=${fallbackBand}`,
      }],
    };
  }

  // Rule 4: baseline provided AND regression (>5% drop in accuracy or F1).
  if (baseline && (baseline.accuracy !== null && baseline.accuracy !== undefined
    || baseline.f1_score !== null && baseline.f1_score !== undefined)) {
    const accDelta = toNumber(current.accuracy, 0) - toNumber(baseline.accuracy, 0);
    const f1Delta = toNumber(current.f1_score, 0) - toNumber(baseline.f1_score, 0);
    if (accDelta < -0.05 || f1Delta < -0.05) {
      return {
        recommendation: 'rollback',
        severity: 'high',
        signals: [{
          code: 'REGRESSION',
          detail: `accuracy_delta=${round2(accDelta)}, f1_delta=${round2(f1Delta)}`,
        }],
      };
    }
    // Rule 5: promote when accuracy improved >= 2% AND safety/fallback are 'ok' or 'watch'.
    if (
      accDelta >= 0.02
      && (safetyBand === 'ok' || safetyBand === 'watch')
      && (fallbackBand === 'ok' || fallbackBand === 'watch')
    ) {
      return {
        recommendation: 'promote',
        severity: 'low',
        signals: [{
          code: 'READY_TO_PROMOTE',
          detail: `accuracy_delta=${round2(accDelta)}`,
        }],
      };
    }
  }

  // Rule 6: stable default.
  return {
    recommendation: 'no_action',
    severity: 'low',
    signals: [{ code: 'STABLE' }],
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
 * ends with the AI-eval-lead disclaimer.
 */
export function buildRegistryActions({ recommendation, signals = [] } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (recommendation) {
    case 'quarantine':
      push('Quarantine the model immediately — halt production traffic and route to the backup model.');
      push('Notify the AI eval lead and model owner; open an incident ticket with the breaching metric snapshot.');
      push('Investigate the root cause of the breach before any further promotion is considered.');
      break;
    case 'rollback':
      push('Roll back the model to the last accepted baseline version for this model key.');
      push('Notify the AI eval lead and model owner; attach the eval-run metrics and the regressed suite.');
      push('Do not re-promote until a subsequent eval-run shows recovery against the baseline.');
      break;
    case 'retire':
      push('Prepare a retirement plan for this model — confirm a replacement model is ready to absorb traffic.');
      push('Notify downstream consumers and schedule the retirement with the AI eval lead.');
      break;
    case 'hold':
      push('Hold the model at its current stage; do not promote until elevated fallback or safety rates resolve.');
      push('Investigate whether elevated rates reflect a real quality issue or a data-shift.');
      break;
    case 'promote':
      push('Queue a promotion proposal for AI eval lead review — metrics show improvement over baseline.');
      push('Confirm safety-flag and fallback rates remain in a healthy band before the promotion goes live.');
      break;
    case 'no_action':
    default:
      push('No lifecycle change recommended; continue routine monitoring.');
      break;
  }

  // Supplementary action hints from matched signal codes.
  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'LATENCY_BREACH') {
      push('Review recent infrastructure changes and provider-side latency before resuming traffic.');
    } else if (code === 'FALLBACK_BREACH') {
      push('Inspect fallback logs to identify the dominant failure mode feeding the fallback rate.');
    } else if (code === 'SAFETY_FLAG_BREACH') {
      push('Escalate to AI governance — safety-flag rate exceeds the production threshold.');
    } else if (code === 'DRIFT_BREACH') {
      push('Rerun the drift canary suite with a fresh reference window to confirm the drift signal.');
    } else if (code === 'REGRESSION') {
      push('Diff the failing suite cases against the baseline to locate the regression source.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary for the eval-run row.
 */
export function summarizeEval({
  modelKey,
  version,
  suite,
  recommendation,
  severity,
  accuracy,
  driftScore,
} = {}) {
  const key = cleanText(modelKey) || 'model';
  const ver = cleanText(version) || 'unknown';
  const s = cleanText(suite) || 'suite';
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const accText = accuracy === null || accuracy === undefined ? 'n/a' : toNumber(accuracy, 0);
  const driftText = driftScore === null || driftScore === undefined ? 'n/a' : toNumber(driftScore, 0);
  return `${key}@${ver} [${s}]: ${rec} (${sev}) — accuracy=${accText}, drift=${driftText}.`;
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

function normalizeRegistryRow(row) {
  if (!row) return row;
  return {
    ...row,
  };
}

function normalizeEvalRow(row) {
  if (!row) return row;
  return {
    ...row,
    model_registry_id: row.model_registry_id !== null && row.model_registry_id !== undefined
      ? toNumber(row.model_registry_id, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    sample_count: row.sample_count !== null && row.sample_count !== undefined
      ? toNumber(row.sample_count, 0)
      : 0,
    pass_count: row.pass_count !== null && row.pass_count !== undefined
      ? toNumber(row.pass_count, 0)
      : 0,
    fail_count: row.fail_count !== null && row.fail_count !== undefined
      ? toNumber(row.fail_count, 0)
      : 0,
    accuracy: row.accuracy !== null && row.accuracy !== undefined
      ? toNumber(row.accuracy, null)
      : null,
    f1_score: row.f1_score !== null && row.f1_score !== undefined
      ? toNumber(row.f1_score, null)
      : null,
    avg_latency_ms: row.avg_latency_ms !== null && row.avg_latency_ms !== undefined
      ? toNumber(row.avg_latency_ms, null)
      : null,
    fallback_rate_pct: row.fallback_rate_pct !== null && row.fallback_rate_pct !== undefined
      ? toNumber(row.fallback_rate_pct, null)
      : null,
    safety_flag_rate_pct: row.safety_flag_rate_pct !== null && row.safety_flag_rate_pct !== undefined
      ? toNumber(row.safety_flag_rate_pct, null)
      : null,
    drift_score: row.drift_score !== null && row.drift_score !== undefined
      ? toNumber(row.drift_score, null)
      : null,
  };
}

async function lookupRegistryRow(tenantId, modelKey, version) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, model_key, version, provider, purpose, owner,
              stage, parent_version, lineage, approval_status, approval_note,
              approved_by, approved_at, retired_at, metadata,
              created_at, updated_at
       FROM clinical_ai_model_registry
       WHERE tenant_id = $1::uuid
         AND model_key = $2
         AND version = $3
       LIMIT 1`,
      tenantId,
      modelKey,
      version
    );
    return normalizeRegistryRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
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
      JSON.stringify({
        ...(metadata || {}),
        generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
        fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || aiResult?.fallback_reason || 'template_or_rule_output',
        readiness_reason: aiResult?.readiness_reason || null,
        provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Model registry workbench generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module, modelKey, version }) {
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE'],
        source: 'model_registry_workbench',
        model_key: modelKey || null,
        version: version || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Model registry workbench review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Insert or update a model-registry row by (tenant, model_key, version).
 * Does NOT overwrite stage or approval_status — those are managed by
 * changeModelStage().
 */
export async function upsertModelRegistry({
  tenantId = null,
  modelKey,
  version,
  provider = null,
  purpose = null,
  owner = null,
  parentVersion = null,
  lineage = {},
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const key = cleanText(modelKey);
  if (!key) throw AppError.badRequest('model_key is required');
  const ver = cleanText(version);
  if (!ver) throw AppError.badRequest('version is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_model_registry
         (tenant_id, model_key, version, provider, purpose, owner,
          parent_version, lineage, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, model_key, version)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         purpose = EXCLUDED.purpose,
         owner = EXCLUDED.owner,
         parent_version = EXCLUDED.parent_version,
         lineage = EXCLUDED.lineage,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, model_key, version, provider, purpose, owner,
                 stage, parent_version, lineage, approval_status, approval_note,
                 approved_by, approved_at, retired_at, metadata,
                 created_at, updated_at`,
      tid,
      key,
      ver,
      provider ? cleanText(provider) : null,
      purpose ? cleanText(purpose) : null,
      owner ? cleanText(owner) : null,
      parentVersion ? cleanText(parentVersion) : null,
      JSON.stringify(lineage || {}),
      JSON.stringify(metadata || {})
    );
    return normalizeRegistryRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List model registry rows for the tenant. Filter by modelKey, stage,
 * approvalStatus, owner. Limit 1..200.
 */
export async function listModelRegistry({
  tenantId = null,
  modelKey = null,
  stage = null,
  approvalStatus = null,
  owner = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedKey = modelKey ? cleanText(modelKey) : null;
  const normalizedStage = stage && STAGES.has(cleanText(stage).toLowerCase())
    ? cleanText(stage).toLowerCase()
    : null;
  const normalizedApproval = approvalStatus
    && APPROVAL_STATES.has(cleanText(approvalStatus).toLowerCase())
    ? cleanText(approvalStatus).toLowerCase()
    : null;
  const normalizedOwner = owner ? cleanText(owner) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, model_key, version, provider, purpose, owner,
              stage, parent_version, lineage, approval_status, approval_note,
              approved_by, approved_at, retired_at, metadata,
              created_at, updated_at
       FROM clinical_ai_model_registry
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR model_key = $2)
         AND ($3::text IS NULL OR stage = $3)
         AND ($4::text IS NULL OR approval_status = $4)
         AND ($5::text IS NULL OR owner = $5)
       ORDER BY model_key ASC, version DESC, created_at DESC
       LIMIT $6`,
      tid,
      normalizedKey,
      normalizedStage,
      normalizedApproval,
      normalizedOwner,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeRegistryRow);
    return { models: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { models: [], count: 0 };
    throw err;
  }
}

/**
 * Update stage and/or approval_status for a registry row. Sets
 * retired_at when stage is 'deprecated' or 'quarantined'.
 */
export async function changeModelStage({
  tenantId = null,
  registryId,
  stage,
  approvalStatus = null,
  approvalNote = null,
  approvedBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = optionalInt(registryId, 'registry_id');
  const normalizedStage = cleanText(stage).toLowerCase();
  if (!STAGES.has(normalizedStage)) {
    throw AppError.badRequest(`stage must be one of: ${Array.from(STAGES).join(', ')}`);
  }
  const normalizedApproval = approvalStatus ? cleanText(approvalStatus).toLowerCase() : null;
  if (normalizedApproval && !APPROVAL_STATES.has(normalizedApproval)) {
    throw AppError.badRequest(`approval_status must be one of: ${Array.from(APPROVAL_STATES).join(', ')}`);
  }
  const retired = normalizedStage === 'deprecated' || normalizedStage === 'quarantined';

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_model_registry
     SET stage = $2,
         approval_status = COALESCE($3, approval_status),
         approval_note = COALESCE($4, approval_note),
         approved_by = COALESCE($5::uuid, approved_by),
         approved_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE approved_at END,
         retired_at = CASE WHEN $6::boolean THEN NOW() ELSE retired_at END,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $7::uuid
     RETURNING id, tenant_id, model_key, version, provider, purpose, owner,
               stage, parent_version, lineage, approval_status, approval_note,
               approved_by, approved_at, retired_at, metadata,
               created_at, updated_at`,
    id,
    normalizedStage,
    normalizedApproval,
    approvalNote ? cleanText(approvalNote) : null,
    approvedBy || null,
    retired,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Model registry entry not found');
  return normalizeRegistryRow(rows[0]);
}

/**
 * Record an eval-run for a model+suite and produce a rules-authoritative
 * lifecycle recommendation.
 */
export async function recordEvalRun({
  req = null,
  modelKey,
  version,
  suite,
  sampleCount = 0,
  passCount = 0,
  failCount = 0,
  accuracy = null,
  f1Score = null,
  avgLatencyMs = null,
  fallbackRatePct = null,
  safetyFlagRatePct = null,
  driftScore = null,
  baselineMetrics = null,
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  // Validate inputs.
  const key = cleanText(modelKey);
  if (!key) throw AppError.badRequest('model_key is required');
  const ver = cleanText(version);
  if (!ver) throw AppError.badRequest('version is required');
  const suiteName = cleanText(suite);
  if (!suiteName) throw AppError.badRequest('suite is required');

  // Coerce numeric inputs.
  const accVal = toNullableNumber(accuracy);
  const f1Val = toNullableNumber(f1Score);
  const latVal = toNullableNumber(avgLatencyMs);
  const fallbackVal = toNullableNumber(fallbackRatePct);
  const safetyVal = toNullableNumber(safetyFlagRatePct);
  const driftVal = toNullableNumber(driftScore);

  const currentMetrics = {
    accuracy: accVal,
    f1_score: f1Val,
    avg_latency_ms: latVal,
    fallback_rate_pct: fallbackVal,
    safety_flag_rate_pct: safetyVal,
    drift_score: driftVal,
  };

  // Classification.
  const classification = classifyEvalRecommendation({
    current: currentMetrics,
    baseline: baselineMetrics || null,
  });

  // Build summary and actions.
  const summary = summarizeEval({
    modelKey: key,
    version: ver,
    suite: suiteName,
    recommendation: classification.recommendation,
    severity: classification.severity,
    accuracy: accVal,
    driftScore: driftVal,
  });
  const recommendedActions = buildRegistryActions({
    recommendation: classification.recommendation,
    signals: classification.signals,
  });

  // Citations: registry lookup (optional), suite ref, rules ref.
  const registryRow = await lookupRegistryRow(tenantId, key, ver);
  const citations = [];
  if (registryRow) {
    citations.push({
      source_type: 'model_registry',
      source_id: String(registryRow.id),
      label: `Model registry — ${key}@${ver}`,
      timestamp: registryRow.updated_at || registryRow.created_at || null,
    });
  }
  citations.push({
    source_type: 'eval_suite',
    source_id: suiteName,
    label: `Eval suite — ${suiteName}`,
    timestamp: null,
  });
  citations.push({
    source_type: 'model_registry_rules',
    source_id: MODULE_KEY,
    label: 'Model registry rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.recommendation === 'quarantine' || classification.recommendation === 'rollback') {
    safetyFlags.push({
      severity: 'critical',
      code: 'MODEL_LIFECYCLE_CRITICAL',
      message: `Recommendation '${classification.recommendation}' — immediate AI eval lead attention required.`,
    });
  }
  if (classification.recommendation === 'hold') {
    safetyFlags.push({
      severity: 'medium',
      code: 'MODEL_LIFECYCLE_HOLD',
      message: 'Model on hold — elevated fallback or safety-flag rate warrants investigation before promotion.',
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Eval-run has no source citations.',
    });
  }

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    model_key: key,
    version: ver,
    suite: suiteName,
    sample_count: toNumber(sampleCount, 0),
    pass_count: toNumber(passCount, 0),
    fail_count: toNumber(failCount, 0),
    metrics: currentMetrics,
    baseline_metrics: baselineMetrics || null,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // Optional AI narrative.
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        model: { model_key: key, version: ver, registry: registryRow || null },
        suite: suiteName,
        metrics: currentMetrics,
        baseline: baselineMetrics || null,
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
        // Never let the AI override rule-based fields.
      };
    }
  } catch (err) {
    logger.debug('Model registry AI narrative unavailable; using template fallback', {
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
        model: { key, version: ver },
        suite: suiteName,
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  const evalMetadata = {
    ...(metadata || {}),
    module_key: metadata?.module_key || key,
    provider: metadata?.provider || registryRow?.provider || aiResult?.provider || 'template',
    model: metadata?.model || aiResult?.model || ver,
  };

  // Persist generation.
  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      model_key: key,
      version: ver,
      suite: suiteName,
      metrics: currentMetrics,
      recommendation: classification.recommendation,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      ...evalMetadata,
      model_key: key,
      version: ver,
      suite: suiteName,
      recommendation: classification.recommendation,
      severity: classification.severity,
      signal_codes: classification.signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist eval-run row.
  let runRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_model_eval_runs
         (tenant_id, model_registry_id, model_key, version, suite, generation_id,
          sample_count, pass_count, fail_count,
          accuracy, f1_score, avg_latency_ms, fallback_rate_pct,
          safety_flag_rate_pct, drift_score,
          recommendation, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6,
               $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15,
               $16, $17, $18::jsonb, $19, $20::jsonb,
               $21::jsonb, $22::jsonb, 'pending', $23::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, model_registry_id, model_key, version, suite,
                 generation_id, sample_count, pass_count, fail_count,
                 accuracy, f1_score, avg_latency_ms, fallback_rate_pct,
                 safety_flag_rate_pct, drift_score, recommendation, severity,
                 signals, summary, recommended_actions, source_citations,
                 safety_flags, reviewer_decision, reviewed_by, reviewed_at,
                 reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      registryRow?.id || null,
      key,
      ver,
      suiteName,
      generation?.id || null,
      toNumber(sampleCount, 0),
      toNumber(passCount, 0),
      toNumber(failCount, 0),
      accVal,
      f1Val,
      latVal,
      fallbackVal,
      safetyVal,
      driftVal,
      RECOMMENDATIONS.has(classification.recommendation) ? classification.recommendation : 'unknown',
      SEVERITIES.has(classification.severity) ? classification.severity : 'unknown',
      JSON.stringify(asArray(classification.signals)),
      draft.summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(draft.source_citations)),
      JSON.stringify(asArray(combinedFlags)),
      JSON.stringify(evalMetadata)
    );
    runRow = normalizeEvalRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        run_id: null,
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
        reason: 'clinical_ai_model_eval_runs_unavailable',
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
    modelKey: key,
    version: ver,
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.model_eval_recorded',
      aggregateType: 'clinical_ai_model_eval_run',
      aggregateId: runRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        run_id: runRow.id,
        generation_id: generation?.id || null,
        model_key: key,
        version: ver,
        suite: suiteName,
        recommendation: classification.recommendation,
        severity: classification.severity,
        signal_codes: classification.signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Model registry workbench event publish failed', { error: err?.message });
  }

  return {
    run_id: runRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    run: runRow,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || runRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
      fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || aiResult?.fallback_reason || 'template_or_rule_output',
      readiness_reason: aiResult?.readiness_reason || null,
      provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

/**
 * List eval-run rows for the tenant. Severity-sorted (critical first),
 * then created_at DESC.
 */
export async function listEvalRuns({
  tenantId = null,
  modelKey = null,
  version = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedKey = modelKey ? cleanText(modelKey) : null;
  const normalizedVersion = version ? cleanText(version) : null;
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
      `SELECT r.id, r.tenant_id, r.model_registry_id, r.model_key, r.version, r.suite,
              r.generation_id, r.sample_count, r.pass_count, r.fail_count,
              r.accuracy, r.f1_score, r.avg_latency_ms, r.fallback_rate_pct,
              r.safety_flag_rate_pct, r.drift_score, r.recommendation, r.severity,
              r.signals, r.summary, r.recommended_actions, r.source_citations,
              r.safety_flags, r.reviewer_decision, r.reviewed_by, r.reviewed_at,
              r.reviewer_note, r.metadata, r.created_at, r.updated_at
       FROM clinical_ai_model_eval_runs r
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.model_key = $2)
         AND ($3::text IS NULL OR r.version = $3)
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
      normalizedKey,
      normalizedVersion,
      normalizedRec,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeEvalRow);
    return { runs: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

/**
 * Record an AI eval lead decision on an eval-run row.
 */
export async function decideEvalRun({
  tenantId = null,
  runId,
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
    `UPDATE clinical_ai_model_eval_runs
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, model_registry_id, model_key, version, suite,
               generation_id, sample_count, pass_count, fail_count,
               accuracy, f1_score, avg_latency_ms, fallback_rate_pct,
               safety_flag_rate_pct, drift_score, recommendation, severity,
               signals, summary, recommended_actions, source_citations,
               safety_flags, reviewer_decision, reviewed_by, reviewed_at,
               reviewer_note, metadata, created_at, updated_at`,
    optionalInt(runId, 'run_id'),
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Model eval run not found');
  return normalizeEvalRow(rows[0]);
}

export default {
  STAGES,
  APPROVAL_STATES,
  RECOMMENDATIONS,
  SEVERITIES,
  SEVERITY_PRIORITY,
  RECOMMENDATION_PRIORITY,
  computeRate,
  computeDelta,
  classifyLatencyBand,
  classifyFallbackBand,
  classifySafetyFlagBand,
  classifyAccuracyBand,
  classifyDriftBand,
  classifyEvalRecommendation,
  escalateSeverity,
  escalateRecommendation,
  buildRegistryActions,
  summarizeEval,
  upsertModelRegistry,
  listModelRegistry,
  changeModelStage,
  recordEvalRun,
  listEvalRuns,
  decideEvalRun,
};
