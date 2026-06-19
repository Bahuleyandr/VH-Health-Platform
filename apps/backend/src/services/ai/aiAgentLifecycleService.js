/**
 * AI Agent Lifecycle Manager.
 *
 * Registry of AI agents (distinct from models — the model registry
 * module tracks model variants). An agent is a persistent unit that
 * invokes models, takes actions, and holds scoped permissions (e.g.
 * read_patient_summary, write_draft, publish_translation). The registry
 * captures agent_key, owner, purpose, scopes, permitted actions,
 * expiry, last_seen, and lifecycle stage. The lifecycle module records
 * periodic health reports (invocation count, success rate, avg latency,
 * error rate, permission-vs-usage mismatch) and classifies each agent
 * as renew / hold / retire / quarantine / no_action. Rules are
 * authoritative. Review-only — AI governance approves renewals and
 * retirements; the module never disables or extends an agent
 * automatically.
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

const MODULE_KEY = 'ai_agent_lifecycle_manager';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the AI agent lifecycle manager. Rules are authoritative. Return JSON only and never disable, retire, or extend an agent automatically — AI governance review is required for every lifecycle change.',
  user_prompt_template:
    'Given the agent registry entry, the latest health-report metrics, and the rule-based recommendation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation or severity.',
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
  'pending_renewal',
]);

export const RECOMMENDATIONS = new Set([
  'renew',
  'hold',
  'retire',
  'quarantine',
  'no_action',
  'unknown',
]);

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

// Priority: higher index = higher priority.
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const RECOMMENDATION_PRIORITY = [
  'unknown',
  'no_action',
  'hold',
  'renew',
  'retire',
  'quarantine',
];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'AI governance review required — decision support only; agent lifecycle is never changed automatically.';

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

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const b = toDate instanceof Date ? toDate : new Date(toDate);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((b.getTime() - a.getTime()) / msPerDay);
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Percentage of successCount / invocationCount, clamped 0..100, 2 dp.
 *   invocationCount <= 0 → 100 (no data → treat as healthy baseline)
 *   successCount >= invocationCount → 100
 */
export function computeSuccessRate({ successCount, invocationCount } = {}) {
  const inv = toNumber(invocationCount, 0);
  const suc = toNumber(successCount, 0);
  if (inv <= 0) return 100;
  if (suc >= inv) return 100;
  const raw = (suc / inv) * 100;
  return round2(Math.max(0, Math.min(100, raw)));
}

/**
 * Percentage of errorCount / invocationCount, clamped 0..100, 2 dp.
 *   invocationCount <= 0 → 0
 */
export function computeErrorRate({ errorCount, invocationCount } = {}) {
  const inv = toNumber(invocationCount, 0);
  const err = toNumber(errorCount, 0);
  if (inv <= 0) return 0;
  const raw = (err / inv) * 100;
  return round2(Math.max(0, Math.min(100, raw)));
}

/**
 * Success-rate band classifier:
 *   null → 'unknown'
 *   >= 99 → 'excellent'
 *   >= 95 → 'good'
 *   >= 80 → 'acceptable'
 *   <  80 → 'poor'
 */
export function classifySuccessBand(successRatePct) {
  if (successRatePct === null || successRatePct === undefined) return 'unknown';
  const v = toNullableNumber(successRatePct);
  if (v === null) return 'unknown';
  if (v >= 99) return 'excellent';
  if (v >= 95) return 'good';
  if (v >= 80) return 'acceptable';
  return 'poor';
}

/**
 * Error-rate band classifier:
 *   null → 'unknown'
 *   < 1  → 'ok'
 *   < 5  → 'watch'
 *   < 15 → 'warning'
 *   >=15 → 'breach'
 */
export function classifyErrorBand(errorRatePct) {
  if (errorRatePct === null || errorRatePct === undefined) return 'unknown';
  const v = toNullableNumber(errorRatePct);
  if (v === null) return 'unknown';
  if (v < 1) return 'ok';
  if (v < 5) return 'watch';
  if (v < 15) return 'warning';
  return 'breach';
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
 * Last-seen band classifier:
 *   null → 'unknown'
 *   <= 7  → 'active'
 *   <= 30 → 'watch'
 *   <= 90 → 'dormant'
 *   > 90  → 'stale'
 */
export function classifyLastSeenBand(daysSinceLastSeen) {
  if (daysSinceLastSeen === null || daysSinceLastSeen === undefined) return 'unknown';
  const v = toNullableNumber(daysSinceLastSeen);
  if (v === null) return 'unknown';
  if (v <= 7) return 'active';
  if (v <= 30) return 'watch';
  if (v <= 90) return 'dormant';
  return 'stale';
}

/**
 * Expiry band classifier:
 *   null → 'unknown'
 *   < 0   → 'expired'
 *   <= 30 → 'imminent'
 *   <= 90 → 'warning'
 *   <= 180 → 'watch'
 *   > 180 → 'ok'
 */
export function classifyExpiryBand(daysToExpiry) {
  if (daysToExpiry === null || daysToExpiry === undefined) return 'unknown';
  const v = toNullableNumber(daysToExpiry);
  if (v === null) return 'unknown';
  if (v < 0) return 'expired';
  if (v <= 30) return 'imminent';
  if (v <= 90) return 'warning';
  if (v <= 180) return 'watch';
  return 'ok';
}

/**
 * Rules-authoritative agent lifecycle classifier. First match wins.
 *
 * Returns { recommendation, severity, signals: [{ code, detail? }] }.
 */
export function classifyAgentHealth({
  successRatePct = null,
  errorRatePct = null,
  avgLatencyMs = null,
  permissionMismatchCount = 0,
  daysSinceLastSeen = null,
  daysToExpiry = null,
  invocationCount = 0,
} = {}) {
  const successBand = classifySuccessBand(successRatePct);
  const errorBand = classifyErrorBand(errorRatePct);
  const latencyBand = classifyLatencyBand(avgLatencyMs);
  const lastSeenBand = classifyLastSeenBand(daysSinceLastSeen);
  const expiryBand = classifyExpiryBand(daysToExpiry);
  const mismatch = toNumber(permissionMismatchCount, 0);
  const invCount = toNumber(invocationCount, 0);

  // Rule 1: permission mismatch >= 5 OR error breach → quarantine/critical.
  if (mismatch >= 5 || errorBand === 'breach') {
    const signals = [];
    if (mismatch >= 5) {
      signals.push({
        code: 'PERMISSION_MISMATCH',
        detail: `permission_mismatch_count=${mismatch}`,
      });
    }
    if (errorBand === 'breach') {
      signals.push({
        code: 'ERROR_BREACH',
        detail: `error_rate_pct=${errorRatePct}`,
      });
    }
    return {
      recommendation: 'quarantine',
      severity: 'critical',
      signals,
    };
  }

  // Rule 2: expired → retire/critical.
  if (expiryBand === 'expired') {
    return {
      recommendation: 'retire',
      severity: 'critical',
      signals: [{ code: 'EXPIRED', detail: `days_to_expiry=${daysToExpiry}` }],
    };
  }

  // Rule 3: expiry imminent → renew/high.
  if (expiryBand === 'imminent') {
    return {
      recommendation: 'renew',
      severity: 'high',
      signals: [{ code: 'EXPIRY_IMMINENT', detail: `days_to_expiry=${daysToExpiry}` }],
    };
  }

  // Rule 4: success 'poor' OR error 'warning' → hold/high.
  if (successBand === 'poor' || errorBand === 'warning') {
    return {
      recommendation: 'hold',
      severity: 'high',
      signals: [{
        code: 'DEGRADED_HEALTH',
        detail: `success=${successBand}, error=${errorBand}`,
      }],
    };
  }

  // Rule 5: last-seen 'stale' → retire/moderate.
  if (lastSeenBand === 'stale') {
    return {
      recommendation: 'retire',
      severity: 'moderate',
      signals: [{ code: 'INACTIVE_AGENT', detail: `days_since_last_seen=${daysSinceLastSeen}` }],
    };
  }

  // Rule 6: last-seen 'dormant' → hold/moderate.
  if (lastSeenBand === 'dormant') {
    return {
      recommendation: 'hold',
      severity: 'moderate',
      signals: [{ code: 'INACTIVE_AGENT', detail: `days_since_last_seen=${daysSinceLastSeen}` }],
    };
  }

  // Rule 7: expiry 'warning' → renew/moderate.
  if (expiryBand === 'warning') {
    return {
      recommendation: 'renew',
      severity: 'moderate',
      signals: [{ code: 'EXPIRY_WARNING', detail: `days_to_expiry=${daysToExpiry}` }],
    };
  }

  // Rule 8: success 'acceptable' OR latency 'slow' → hold/low.
  // (errorBand 'watch' is 1-5%, still within normal agent operating band;
  // combined with a healthy success band it does not warrant a hold.)
  if (successBand === 'acceptable' || latencyBand === 'slow') {
    return {
      recommendation: 'hold',
      severity: 'low',
      signals: [{
        code: 'WATCH',
        detail: `success=${successBand}, latency=${latencyBand}, error=${errorBand}`,
      }],
    };
  }

  // Rule 9: no activity yet → no_action/low.
  if (invCount === 0 && (daysSinceLastSeen === null || daysSinceLastSeen === undefined)) {
    return {
      recommendation: 'no_action',
      severity: 'low',
      signals: [{ code: 'NO_ACTIVITY_YET' }],
    };
  }

  // Rule 10: healthy default.
  return {
    recommendation: 'no_action',
    severity: 'low',
    signals: [{ code: 'HEALTHY' }],
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
 * Build reviewer-facing action lines. Always ends with the AI-governance
 * disclaimer.
 */
export function buildAgentActions({ recommendation, signals = [], agentKey = null } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  const keyLabel = cleanText(agentKey) || 'this agent';

  switch (recommendation) {
    case 'quarantine':
      push(`Quarantine ${keyLabel} immediately — suspend all scoped actions pending AI governance review.`);
      push('Notify the agent owner and AI governance; open an incident ticket with the breaching metric snapshot.');
      push('Review the agent scopes against recent usage to understand the permission-vs-usage gap before any re-enablement.');
      break;
    case 'retire':
      push(`Prepare a retirement plan for ${keyLabel} — confirm no downstream workflows still depend on it.`);
      push('Notify downstream consumers and schedule retirement with AI governance.');
      break;
    case 'renew':
      push(`Queue a renewal proposal for ${keyLabel} for AI governance review before the current expiry.`);
      push('Confirm the owner, purpose, and scopes still reflect current usage; update registry if anything has drifted.');
      break;
    case 'hold':
      push(`Hold ${keyLabel} at its current stage; investigate the degraded-health signal before any promotion.`);
      push('Review invocation logs and recent error traces to determine whether the cause is the agent or an upstream model.');
      break;
    case 'no_action':
    default:
      push(`No lifecycle change recommended for ${keyLabel}; continue routine monitoring.`);
      break;
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'PERMISSION_MISMATCH') {
      push('Audit the scope list against actual invocations — remove unused scopes and investigate any over-privileged calls.');
    } else if (code === 'ERROR_BREACH') {
      push('Open an incident ticket — error rate exceeds the production threshold.');
    } else if (code === 'EXPIRED') {
      push(`The expiry date for ${keyLabel} has already passed; do not extend automatically.`);
    } else if (code === 'EXPIRY_IMMINENT' || code === 'EXPIRY_WARNING') {
      push('Review renewal paperwork with the owner; confirm the agent is still required before extending.');
    } else if (code === 'INACTIVE_AGENT') {
      push('Check with the owner whether the agent is still needed or if its workload has moved elsewhere.');
    } else if (code === 'DEGRADED_HEALTH') {
      push('Diff recent invocation outcomes against the prior healthy window to pinpoint the regression source.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary of the agent health report.
 */
export function summarizeAgent({
  agentKey,
  recommendation,
  severity,
  successRatePct,
  errorRatePct,
  daysToExpiry,
} = {}) {
  const key = cleanText(agentKey) || 'agent';
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const succText = successRatePct === null || successRatePct === undefined
    ? 'n/a'
    : toNumber(successRatePct, 0);
  const errText = errorRatePct === null || errorRatePct === undefined
    ? 'n/a'
    : toNumber(errorRatePct, 0);
  const expText = daysToExpiry === null || daysToExpiry === undefined
    ? 'n/a'
    : toNumber(daysToExpiry, 0);
  return `${key}: ${rec} (${sev}) — success=${succText}%, error=${errText}%, days_to_expiry=${expText}.`;
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
  return { ...row };
}

function normalizeHealthRow(row) {
  if (!row) return row;
  return {
    ...row,
    agent_registry_id: row.agent_registry_id !== null && row.agent_registry_id !== undefined
      ? toNumber(row.agent_registry_id, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    invocation_count: toNumber(row.invocation_count, 0),
    success_count: toNumber(row.success_count, 0),
    error_count: toNumber(row.error_count, 0),
    avg_latency_ms: row.avg_latency_ms !== null && row.avg_latency_ms !== undefined
      ? toNumber(row.avg_latency_ms, null)
      : null,
    permission_mismatch_count: toNumber(row.permission_mismatch_count, 0),
    days_since_last_seen: row.days_since_last_seen !== null && row.days_since_last_seen !== undefined
      ? toNumber(row.days_since_last_seen, null)
      : null,
    days_to_expiry: row.days_to_expiry !== null && row.days_to_expiry !== undefined
      ? toNumber(row.days_to_expiry, null)
      : null,
  };
}

async function lookupRegistryRow(tenantId, agentKey) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, agent_key, display_name, owner, purpose,
              scopes, permitted_actions, stage, expiry_date, last_seen_at,
              approval_status, approval_note, approved_by, approved_at,
              retired_at, metadata, created_at, updated_at
       FROM clinical_ai_agent_registry
       WHERE tenant_id = $1::uuid
         AND agent_key = $2
       LIMIT 1`,
      tenantId,
      agentKey
    );
    return normalizeRegistryRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function touchRegistryLastSeen(tenantId, agentKey, lastSeenAt) {
  try {
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_agent_registry
       SET last_seen_at = COALESCE($3::timestamptz, NOW()),
           updated_at = NOW()
       WHERE tenant_id = $1::uuid
         AND agent_key = $2`,
      tenantId,
      agentKey,
      lastSeenAt || null
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Agent lifecycle last_seen_at update failed', { error: err?.message });
    }
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
      logger.warn('Agent lifecycle generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module, agentKey }) {
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
        source: 'ai_agent_lifecycle_manager',
        agent_key: agentKey || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Agent lifecycle review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Insert or update an agent registry row by (tenant_id, agent_key).
 * Does NOT overwrite stage or approval_status — those are managed by
 * changeAgentStage().
 */
export async function upsertAgentRegistry({
  tenantId = null,
  agentKey,
  displayName = null,
  owner = null,
  purpose = null,
  scopes = [],
  permittedActions = [],
  expiryDate = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const key = cleanText(agentKey);
  if (!key) throw AppError.badRequest('agent_key is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_agent_registry
         (tenant_id, agent_key, display_name, owner, purpose, scopes,
          permitted_actions, expiry_date, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::date, $9::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, agent_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         owner = EXCLUDED.owner,
         purpose = EXCLUDED.purpose,
         scopes = EXCLUDED.scopes,
         permitted_actions = EXCLUDED.permitted_actions,
         expiry_date = EXCLUDED.expiry_date,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, agent_key, display_name, owner, purpose,
                 scopes, permitted_actions, stage, expiry_date, last_seen_at,
                 approval_status, approval_note, approved_by, approved_at,
                 retired_at, metadata, created_at, updated_at`,
      tid,
      key,
      displayName ? cleanText(displayName) : null,
      owner ? cleanText(owner) : null,
      purpose ? cleanText(purpose) : null,
      JSON.stringify(asArray(scopes)),
      JSON.stringify(asArray(permittedActions)),
      expiryDate || null,
      JSON.stringify(metadata || {})
    );
    return normalizeRegistryRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * List agent-registry rows for the tenant. Filter by agentKey, stage,
 * approvalStatus, owner. Limit 1..200.
 */
export async function listAgentRegistry({
  tenantId = null,
  agentKey = null,
  stage = null,
  approvalStatus = null,
  owner = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedKey = agentKey ? cleanText(agentKey) : null;
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
      `SELECT id, tenant_id, agent_key, display_name, owner, purpose,
              scopes, permitted_actions, stage, expiry_date, last_seen_at,
              approval_status, approval_note, approved_by, approved_at,
              retired_at, metadata, created_at, updated_at
       FROM clinical_ai_agent_registry
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR agent_key = $2)
         AND ($3::text IS NULL OR stage = $3)
         AND ($4::text IS NULL OR approval_status = $4)
         AND ($5::text IS NULL OR owner = $5)
       ORDER BY agent_key ASC, created_at DESC
       LIMIT $6`,
      tid,
      normalizedKey,
      normalizedStage,
      normalizedApproval,
      normalizedOwner,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeRegistryRow);
    return { agents: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { agents: [], count: 0 };
    throw err;
  }
}

/**
 * Update stage and/or approval_status for an agent registry row. Sets
 * retired_at when stage becomes 'deprecated' or 'quarantined'.
 */
export async function changeAgentStage({
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
    `UPDATE clinical_ai_agent_registry
     SET stage = $2,
         approval_status = COALESCE($3, approval_status),
         approval_note = COALESCE($4, approval_note),
         approved_by = COALESCE($5::uuid, approved_by),
         approved_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE approved_at END,
         retired_at = CASE WHEN $6::boolean THEN NOW() ELSE retired_at END,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $7::uuid
     RETURNING id, tenant_id, agent_key, display_name, owner, purpose,
               scopes, permitted_actions, stage, expiry_date, last_seen_at,
               approval_status, approval_note, approved_by, approved_at,
               retired_at, metadata, created_at, updated_at`,
    id,
    normalizedStage,
    normalizedApproval,
    approvalNote ? cleanText(approvalNote) : null,
    approvedBy || null,
    retired,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Agent registry entry not found');
  return normalizeRegistryRow(rows[0]);
}

/**
 * Record a periodic health report for an agent and produce a
 * rules-authoritative lifecycle recommendation.
 */
export async function recordAgentHealth({
  req = null,
  agentKey,
  invocationCount = 0,
  successCount = 0,
  errorCount = 0,
  avgLatencyMs = null,
  permissionMismatchCount = 0,
  lastSeenAt = null,
  today = null,
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const key = cleanText(agentKey);
  if (!key) throw AppError.badRequest('agent_key is required');

  // Coerce numeric inputs.
  const invCount = toNumber(invocationCount, 0);
  const sucCount = toNumber(successCount, 0);
  const errCount = toNumber(errorCount, 0);
  const latVal = toNullableNumber(avgLatencyMs);
  const mismatchCount = toNumber(permissionMismatchCount, 0);

  const registryRow = await lookupRegistryRow(tenantId, key);

  const todayDate = today ? new Date(today) : new Date();
  const lastSeenDate = lastSeenAt
    ? new Date(lastSeenAt)
    : (registryRow?.last_seen_at ? new Date(registryRow.last_seen_at) : null);
  const expiryDate = registryRow?.expiry_date ? new Date(registryRow.expiry_date) : null;

  const daysSinceLastSeen = lastSeenDate && !Number.isNaN(lastSeenDate.getTime())
    ? daysBetween(lastSeenDate, todayDate)
    : null;
  const daysToExpiry = expiryDate && !Number.isNaN(expiryDate.getTime())
    ? daysBetween(todayDate, expiryDate)
    : null;

  const successRatePct = computeSuccessRate({ successCount: sucCount, invocationCount: invCount });
  const errorRatePct = computeErrorRate({ errorCount: errCount, invocationCount: invCount });

  const classification = classifyAgentHealth({
    successRatePct,
    errorRatePct,
    avgLatencyMs: latVal,
    permissionMismatchCount: mismatchCount,
    daysSinceLastSeen,
    daysToExpiry,
    invocationCount: invCount,
  });

  const summary = summarizeAgent({
    agentKey: key,
    recommendation: classification.recommendation,
    severity: classification.severity,
    successRatePct,
    errorRatePct,
    daysToExpiry,
  });
  const recommendedActions = buildAgentActions({
    recommendation: classification.recommendation,
    signals: classification.signals,
    agentKey: key,
  });

  // Citations.
  const citations = [];
  if (registryRow) {
    citations.push({
      source_type: 'agent_registry',
      source_id: String(registryRow.id),
      label: `Agent registry — ${key}`,
      timestamp: registryRow.updated_at || registryRow.created_at || null,
    });
  }
  citations.push({
    source_type: 'agent_lifecycle_rules',
    source_id: MODULE_KEY,
    label: 'Agent lifecycle rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.recommendation === 'quarantine') {
    safetyFlags.push({
      severity: 'critical',
      code: 'AGENT_LIFECYCLE_CRITICAL',
      message: `Recommendation '${classification.recommendation}' — immediate AI governance attention required.`,
    });
  }
  if (classification.recommendation === 'retire'
    && classification.signals.some((s) => s?.code === 'EXPIRED')) {
    safetyFlags.push({
      severity: 'critical',
      code: 'AGENT_EXPIRED',
      message: 'Agent has passed its expiry date — retire or renew via AI governance.',
    });
  }
  if (mismatchCount > 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'PERMISSION_MISMATCH',
      message: `Permission-vs-usage mismatches detected (${mismatchCount}).`,
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Health report has no source citations.',
    });
  }

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    agent_key: key,
    metrics: {
      invocation_count: invCount,
      success_count: sucCount,
      error_count: errCount,
      avg_latency_ms: latVal,
      permission_mismatch_count: mismatchCount,
      success_rate_pct: successRatePct,
      error_rate_pct: errorRatePct,
      days_since_last_seen: daysSinceLastSeen,
      days_to_expiry: daysToExpiry,
    },
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

  // Optional AI narrative (decorative).
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        agent: {
          agent_key: key,
          registry: registryRow || null,
        },
        metrics: fallbackDraft.metrics,
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
    logger.debug('Agent lifecycle AI narrative unavailable; using template fallback', {
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
        agent: { key },
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
      agent_key: key,
      invocation_count: invCount,
      success_count: sucCount,
      error_count: errCount,
      recommendation: classification.recommendation,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      agent_key: key,
      recommendation: classification.recommendation,
      severity: classification.severity,
      signal_codes: classification.signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist health report row.
  let reportRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_agent_health_reports
         (tenant_id, agent_registry_id, agent_key, generation_id,
          invocation_count, success_count, error_count, avg_latency_ms,
          permission_mismatch_count, days_since_last_seen, days_to_expiry,
          recommendation, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4,
               $5, $6, $7, $8,
               $9, $10, $11,
               $12, $13, $14::jsonb, $15, $16::jsonb,
               $17::jsonb, $18::jsonb, 'pending', $19::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, agent_registry_id, agent_key, generation_id,
                 invocation_count, success_count, error_count, avg_latency_ms,
                 permission_mismatch_count, days_since_last_seen, days_to_expiry,
                 recommendation, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at,
                 retention_until`,
      tenantId,
      registryRow?.id || null,
      key,
      generation?.id || null,
      invCount,
      sucCount,
      errCount,
      latVal,
      mismatchCount,
      daysSinceLastSeen,
      daysToExpiry,
      RECOMMENDATIONS.has(classification.recommendation) ? classification.recommendation : 'unknown',
      SEVERITIES.has(classification.severity) ? classification.severity : 'unknown',
      JSON.stringify(asArray(classification.signals)),
      draft.summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(draft.source_citations)),
      JSON.stringify(asArray(combinedFlags)),
      JSON.stringify(metadata || {})
    );
    reportRow = normalizeHealthRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        report_id: null,
        generation_id: generation?.id || null,
        draft,
        source_citations: draft.source_citations,
        safety_flags: combinedFlags,
        recommendation: classification.recommendation,
        severity: classification.severity,
        signals: classification.signals,
        success_rate_pct: successRatePct,
        error_rate_pct: errorRatePct,
        days_since_last_seen: daysSinceLastSeen,
        days_to_expiry: daysToExpiry,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_agent_health_reports_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      };
    }
    throw err;
  }

  // Best-effort: update registry last_seen_at.
  if (registryRow) {
    await touchRegistryLastSeen(tenantId, key, lastSeenAt);
  }

  // Review placeholder.
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
    agentKey: key,
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.agent_health_recorded',
      aggregateType: 'clinical_ai_agent_health_report',
      aggregateId: reportRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        report_id: reportRow.id,
        generation_id: generation?.id || null,
        agent_key: key,
        recommendation: classification.recommendation,
        severity: classification.severity,
        signal_codes: classification.signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Agent lifecycle event publish failed', { error: err?.message });
  }

  return {
    report_id: reportRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    report: reportRow,
    recommendation: classification.recommendation,
    severity: classification.severity,
    signals: classification.signals,
    success_rate_pct: successRatePct,
    error_rate_pct: errorRatePct,
    days_since_last_seen: daysSinceLastSeen,
    days_to_expiry: daysToExpiry,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || reportRow.reviewer_decision || 'pending',
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
 * List agent health-report rows for the tenant. Severity-sorted
 * (critical first), then created_at DESC.
 */
export async function listAgentHealthReports({
  tenantId = null,
  agentKey = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedKey = agentKey ? cleanText(agentKey) : null;
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
      `SELECT r.id, r.tenant_id, r.agent_registry_id, r.agent_key, r.generation_id,
              r.invocation_count, r.success_count, r.error_count, r.avg_latency_ms,
              r.permission_mismatch_count, r.days_since_last_seen, r.days_to_expiry,
              r.recommendation, r.severity, r.signals, r.summary, r.recommended_actions,
              r.source_citations, r.safety_flags, r.reviewer_decision, r.reviewed_by,
              r.reviewed_at, r.reviewer_note, r.metadata, r.created_at, r.updated_at,
              r.retention_until
       FROM clinical_ai_agent_health_reports r
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.agent_key = $2)
         AND ($3::text IS NULL OR r.recommendation = $3)
         AND ($4::text IS NULL OR r.severity = $4)
         AND ($5::text IS NULL OR r.reviewer_decision = $5)
       ORDER BY
         CASE r.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      normalizedKey,
      normalizedRec,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeHealthRow);
    return { reports: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reports: [], count: 0 };
    throw err;
  }
}

/**
 * Record an AI governance reviewer decision on a health-report row.
 */
export async function decideAgentHealthReport({
  tenantId = null,
  reportId,
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
    `UPDATE clinical_ai_agent_health_reports
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, agent_registry_id, agent_key, generation_id,
               invocation_count, success_count, error_count, avg_latency_ms,
               permission_mismatch_count, days_since_last_seen, days_to_expiry,
               recommendation, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision, reviewed_by,
               reviewed_at, reviewer_note, metadata, created_at, updated_at,
               retention_until`,
    optionalInt(reportId, 'report_id'),
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Agent health report not found');
  return normalizeHealthRow(rows[0]);
}

export default {
  STAGES,
  APPROVAL_STATES,
  RECOMMENDATIONS,
  SEVERITIES,
  SEVERITY_PRIORITY,
  RECOMMENDATION_PRIORITY,
  computeSuccessRate,
  computeErrorRate,
  classifySuccessBand,
  classifyErrorBand,
  classifyLatencyBand,
  classifyLastSeenBand,
  classifyExpiryBand,
  classifyAgentHealth,
  escalateSeverity,
  escalateRecommendation,
  buildAgentActions,
  summarizeAgent,
  upsertAgentRegistry,
  listAgentRegistry,
  changeAgentStage,
  recordAgentHealth,
  listAgentHealthReports,
  decideAgentHealthReport,
};
