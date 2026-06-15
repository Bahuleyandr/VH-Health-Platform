/**
 * Generalized Pathway Bundle Compliance.
 *
 * Generic evaluator for any clinical pathway bundle (stroke Get-With-The-
 * Guidelines, ACS MONA, VTE prophylaxis, insulin/glycemic control, pain
 * management, DVT, etc.). Accepts a pathway spec (list of required action
 * items with timing constraints against a t0_reference) + actual actions
 * with timestamps. Computes per-item compliance
 * (compliant / late / missed / not_applicable / unknown), bundle-wide
 * compliance %, time-to-action deltas, and flags dangerously-late / missed
 * critical items.
 *
 * Rules are authoritative. Review-only — a clinician reviews the draft;
 * the module never administers a medication or places an order. Distinct
 * from sepsis_bundle_sentinel (sepsis-specific); this one is
 * pathway-agnostic.
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
import { groundWithKnowledgeBases } from './knowledgeGroundingService.js';

const MODULE_KEY = 'pathway_bundle_compliance';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support generalized clinical pathway bundle compliance review. Rules are authoritative. Use only the supplied pathway spec, action events with timestamps, and t0 reference time. Return JSON only. Never administer a medication, place an order, or modify any clinical order. Clinician signoff is required before any action.',
  user_prompt_template:
    'Given the pathway spec, action events, t0 reference time, and the rule-based bundle evaluation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not invent items that are not in the pathway spec. If a required item is not applicable per the supplied context flags, defer to the rule-based classification.',
};

// Constants (exported for tests / callers that validate inputs).
export const ITEM_STATUSES = new Set(['compliant', 'late', 'missed', 'not_applicable', 'unknown']);
export const RECOMMENDATIONS = new Set(['no_action', 'catch_up', 'escalate', 'review_pathway', 'critical_miss', 'unknown']);
export const RECOMMENDATION_PRIORITY = ['unknown', 'no_action', 'catch_up', 'review_pathway', 'escalate', 'critical_miss'];
export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Clinician review required — decision support only; the module never administers a medication or places an order.';

// ---------- Built-in pathway presets -------------------------------------

export const PATHWAY_PRESETS = {
  stroke_gwg: {
    pathway_key: 'stroke_gwg',
    display: 'Stroke — Get With The Guidelines',
    items: [
      { item_key: 'ct_brain', display: 'CT brain within 25 min', deadline_minutes: 25, critical: true },
      {
        item_key: 'door_to_needle_tpa',
        display: 'Door-to-needle (IV tPA) within 60 min',
        deadline_minutes: 60,
        critical: true,
        na_when_absent: true,
        na_context_key: 'tpa_candidate',
        na_context_value: false,
      },
      { item_key: 'nihss', display: 'NIHSS documented within 10 min', deadline_minutes: 10 },
      {
        item_key: 'swallow_screen',
        display: 'Swallow screen within 240 min',
        deadline_minutes: 240,
        critical: true,
      },
      {
        item_key: 'dvt_prophylaxis_started',
        display: 'DVT prophylaxis started within 48 h',
        deadline_minutes: 2880,
      },
      {
        item_key: 'stroke_unit_admission',
        display: 'Stroke unit admission within 180 min',
        deadline_minutes: 180,
        critical: true,
      },
    ],
  },
  acs_mona: {
    pathway_key: 'acs_mona',
    display: 'ACS — MONA + reperfusion',
    items: [
      { item_key: 'aspirin', display: 'Aspirin 325 mg within 10 min', deadline_minutes: 10, critical: true },
      { item_key: 'ecg_12_lead', display: '12-lead ECG within 10 min', deadline_minutes: 10, critical: true },
      {
        item_key: 'door_to_balloon_pci',
        display: 'Door-to-balloon (primary PCI) within 90 min',
        deadline_minutes: 90,
        critical: true,
        na_when_absent: true,
        na_context_key: 'pci_candidate',
        na_context_value: false,
      },
      {
        item_key: 'troponin_hs_ordered',
        display: 'High-sensitivity troponin ordered within 30 min',
        deadline_minutes: 30,
      },
      {
        item_key: 'beta_blocker',
        display: 'Beta-blocker within 24 h',
        deadline_minutes: 1440,
        na_when_absent: true,
        na_context_key: 'beta_blocker_contraindicated',
        na_context_value: true,
      },
      { item_key: 'statin', display: 'Statin within 24 h', deadline_minutes: 1440 },
    ],
  },
  vte_prophylaxis: {
    pathway_key: 'vte_prophylaxis',
    display: 'VTE Prophylaxis',
    items: [
      {
        item_key: 'risk_assessment',
        display: 'VTE risk assessment within 24 h',
        deadline_minutes: 1440,
        critical: true,
      },
      {
        item_key: 'pharmacologic_ppx_started',
        display: 'Pharmacologic prophylaxis started within 24 h',
        deadline_minutes: 1440,
        na_when_absent: true,
        na_context_key: 'bleeding_risk',
        na_context_value: 'high',
      },
      {
        item_key: 'mechanical_ppx_applied',
        display: 'Mechanical prophylaxis applied within 24 h',
        deadline_minutes: 1440,
        na_when_absent: true,
        na_context_key: 'mechanical_unavailable',
        na_context_value: true,
      },
    ],
  },
  glycemic_insulin: {
    pathway_key: 'glycemic_insulin',
    display: 'Glycemic / Insulin Protocol',
    items: [
      {
        item_key: 'first_glucose_check',
        display: 'First glucose check within 60 min',
        deadline_minutes: 60,
        critical: true,
      },
      {
        item_key: 'insulin_protocol_initiated',
        display: 'Insulin protocol initiated within 120 min',
        deadline_minutes: 120,
        na_when_absent: true,
        na_context_key: 'normoglycemic',
        na_context_value: true,
      },
      {
        item_key: 'hypoglycemia_treatment_ready',
        display: 'Hypoglycemia treatment kit ready within 60 min',
        deadline_minutes: 60,
      },
      {
        item_key: 'q4h_glucose_monitoring',
        display: 'Q4h glucose monitoring established within 24 h',
        deadline_minutes: 1440,
      },
    ],
  },
};

// ---------- Small helpers -------------------------------------------------

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

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function diffMinutes(actionAt, t0) {
  if (!actionAt || !t0) return null;
  return (actionAt.getTime() - t0.getTime()) / 60000;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Normalize a raw spec entry ({ item_key, display, deadline_minutes, ... }).
 * Strips extra whitespace and coerces numeric fields.
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemKey = cleanText(raw.item_key);
  if (!itemKey) return null;
  const deadline = toNumber(raw.deadline_minutes, NaN);
  return {
    item_key: itemKey,
    display: cleanText(raw.display) || itemKey,
    deadline_minutes: Number.isFinite(deadline) ? deadline : null,
    critical: raw.critical === true,
    na_when_absent: raw.na_when_absent === true,
    na_context_key: raw.na_context_key ? cleanText(raw.na_context_key) : null,
    na_context_value: Object.prototype.hasOwnProperty.call(raw, 'na_context_value')
      ? raw.na_context_value
      : null,
  };
}

function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pathwayKey = cleanText(raw.pathway_key);
  if (!pathwayKey) return null;
  const rawItems = asArray(raw.items).map(normalizeItem).filter(Boolean);
  return {
    pathway_key: pathwayKey,
    display: cleanText(raw.display) || pathwayKey,
    items: rawItems,
  };
}

/**
 * Resolve the pathway spec for a given pathwayKey.
 *
 * - If `customSpec` is provided, normalize and return it (pathwayKey must
 *   match).
 * - Else look up in `PATHWAY_PRESETS`.
 * - Throws AppError.badRequest if neither resolves.
 */
export function getPathwaySpec({ pathwayKey, customSpec = null } = {}) {
  const key = cleanText(pathwayKey);
  if (!key) {
    throw AppError.badRequest('pathway_key is required');
  }
  if (customSpec) {
    const normalized = normalizeSpec({ ...customSpec, pathway_key: customSpec.pathway_key || key });
    if (!normalized) {
      throw AppError.badRequest('customSpec is invalid');
    }
    if (!normalized.items.length) {
      throw AppError.badRequest('customSpec must include at least one item');
    }
    return normalized;
  }
  const preset = PATHWAY_PRESETS[key];
  if (!preset) {
    throw AppError.badRequest(`Unknown pathway_key: ${key}`);
  }
  return normalizeSpec(preset);
}

/**
 * Classify one item.
 *
 * - If item.na_when_absent is true, actionAt is null, and the context flag
 *   matches, return 'not_applicable' with a reason.
 * - Otherwise, if actionAt is null:
 *     - if t0 is null → 'unknown'
 *     - else → 'missed' (required item with no action recorded)
 * - Otherwise, compute delta_minutes and return 'compliant' (≤ deadline) or
 *   'late' (> deadline). Deadline must be finite; otherwise 'unknown'.
 */
export function classifyItemStatus({ item = {}, actionAt = null, t0 = null, context = {} } = {}) {
  const safeItem = normalizeItem(item) || normalizeItem({ item_key: 'unknown' });
  const t0Date = parseTimestamp(t0);
  const actionDate = parseTimestamp(actionAt);
  const deadline = Number.isFinite(safeItem.deadline_minutes) ? Number(safeItem.deadline_minutes) : null;

  // NA branch: if item opts in and the context flag matches AND no action occurred.
  if (safeItem.na_when_absent === true && !actionDate) {
    const key = safeItem.na_context_key;
    if (key && context && Object.prototype.hasOwnProperty.call(context, key)) {
      if (context[key] === safeItem.na_context_value) {
        return {
          status: 'not_applicable',
          delta_minutes: null,
          reason: `${safeItem.item_key} is not applicable because ${key} = ${JSON.stringify(context[key])}`,
        };
      }
    } else if (!key) {
      // Fallback behaviour: any matching NA flag keyed simply by item_key.
      if (context && Object.prototype.hasOwnProperty.call(context, safeItem.item_key) && context[safeItem.item_key] === false) {
        return {
          status: 'not_applicable',
          delta_minutes: null,
          reason: `${safeItem.item_key} is not applicable per context flag`,
        };
      }
    }
  }

  if (!actionDate) {
    if (!t0Date) {
      return { status: 'unknown', delta_minutes: null, reason: 'No t0 reference and no action recorded' };
    }
    if (deadline === null) {
      return { status: 'unknown', delta_minutes: null, reason: 'No deadline defined for this item' };
    }
    return { status: 'missed', delta_minutes: null, reason: 'Required item has no recorded action' };
  }

  if (!t0Date) {
    // We have an action but no t0 — we cannot compute compliance timing.
    return { status: 'unknown', delta_minutes: null, reason: 'Action recorded but no t0 reference provided' };
  }

  const delta = diffMinutes(actionDate, t0Date);
  if (delta === null || !Number.isFinite(delta)) {
    return { status: 'unknown', delta_minutes: null, reason: 'Could not compute time delta' };
  }

  if (deadline === null) {
    // No deadline → treat as compliant once action recorded.
    return { status: 'compliant', delta_minutes: round2(delta) };
  }

  if (delta <= deadline) {
    return { status: 'compliant', delta_minutes: round2(delta) };
  }
  return { status: 'late', delta_minutes: round2(delta) };
}

/**
 * Find the first action in `actions` whose `item_key` matches `itemKey`.
 * Returns null if none is found.
 */
function findActionForItem(actions, itemKey) {
  for (const action of asArray(actions)) {
    if (!action) continue;
    const key = cleanText(action.item_key);
    if (key && key === itemKey) return action;
  }
  return null;
}

/**
 * Full bundle evaluation.
 *
 * Returns per-item classification plus aggregate counts + compliance %.
 */
export function evaluateBundle({
  pathwayKey,
  customSpec = null,
  t0Reference = null,
  actions = [],
  context = {},
} = {}) {
  const spec = getPathwaySpec({ pathwayKey, customSpec });
  const t0Date = parseTimestamp(t0Reference);

  const itemResults = [];
  let compliantCount = 0;
  let lateCount = 0;
  let missedCount = 0;
  let naCount = 0;
  let unknownCount = 0;

  for (const item of spec.items) {
    const action = findActionForItem(actions, item.item_key);
    const actionAt = action ? action.occurred_at || action.action_at || action.timestamp || null : null;
    const classified = classifyItemStatus({
      item,
      actionAt,
      t0: t0Date,
      context,
    });
    const entry = {
      item_key: item.item_key,
      display: item.display,
      critical: Boolean(item.critical),
      status: classified.status,
      delta_minutes: classified.delta_minutes,
      deadline_minutes: Number.isFinite(item.deadline_minutes) ? Number(item.deadline_minutes) : null,
    };
    if (classified.reason) entry.reason = classified.reason;
    itemResults.push(entry);

    switch (classified.status) {
      case 'compliant':
        compliantCount += 1;
        break;
      case 'late':
        lateCount += 1;
        break;
      case 'missed':
        missedCount += 1;
        break;
      case 'not_applicable':
        naCount += 1;
        break;
      default:
        unknownCount += 1;
        break;
    }
  }

  const denom = compliantCount + lateCount + missedCount;
  const compliancePct = denom === 0 ? 100 : round2((compliantCount / denom) * 100);

  return {
    pathway_key: spec.pathway_key,
    pathway_display: spec.display,
    item_results: itemResults,
    compliance_pct: compliancePct,
    compliant_count: compliantCount,
    late_count: lateCount,
    missed_count: missedCount,
    na_count: naCount,
    unknown_count: unknownCount,
  };
}

/**
 * Map an evaluated bundle to severity + recommendation + signals.
 *
 * Precedence (highest first):
 *   1. Any critical missed item           → critical / critical_miss
 *   2. Any critical late item             → high / escalate
 *   3. Non-critical misses (>= 2)         → high / escalate
 *   4. compliance_pct < 50                → high / review_pathway
 *   5. compliance_pct < 80                → moderate / catch_up
 *   6. else                               → low / no_action
 */
export function classifySeverityAndRecommendation({ itemResults = [], compliancePct = null } = {}) {
  const results = asArray(itemResults);
  const signals = [];

  const criticalMissed = results.filter((r) => r && r.critical === true && r.status === 'missed');
  if (criticalMissed.length) {
    signals.push({
      code: 'CRITICAL_ITEM_MISSED',
      detail: `${criticalMissed.length} critical item(s) missed: ${criticalMissed.map((r) => r.item_key).join(', ')}`,
    });
    return { severity: 'critical', recommendation: 'critical_miss', signals };
  }

  const criticalLate = results.filter((r) => r && r.critical === true && r.status === 'late');
  if (criticalLate.length) {
    signals.push({
      code: 'CRITICAL_ITEM_LATE',
      detail: `${criticalLate.length} critical item(s) late: ${criticalLate.map((r) => r.item_key).join(', ')}`,
    });
    return { severity: 'high', recommendation: 'escalate', signals };
  }

  const missedCount = results.filter((r) => r && r.status === 'missed').length;
  if (missedCount >= 2) {
    signals.push({
      code: 'MULTIPLE_MISSES',
      detail: `${missedCount} items missed`,
    });
    return { severity: 'high', recommendation: 'escalate', signals };
  }

  // Compute compliance_pct from itemResults if caller didn't supply one.
  let pct = compliancePct;
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) {
    const compliant = results.filter((r) => r && r.status === 'compliant').length;
    const late = results.filter((r) => r && r.status === 'late').length;
    const missed = results.filter((r) => r && r.status === 'missed').length;
    const denom = compliant + late + missed;
    pct = denom === 0 ? 100 : round2((compliant / denom) * 100);
  } else {
    pct = Number(pct);
  }

  if (pct < 50) {
    signals.push({ code: 'LOW_COMPLIANCE', detail: `Compliance ${pct}% < 50%` });
    return { severity: 'high', recommendation: 'review_pathway', signals };
  }
  if (pct < 80) {
    signals.push({ code: 'PARTIAL_COMPLIANCE', detail: `Compliance ${pct}% < 80%` });
    return { severity: 'moderate', recommendation: 'catch_up', signals };
  }

  signals.push({ code: 'COMPLIANT_PATHWAY', detail: `Compliance ${pct}%` });
  return { severity: 'low', recommendation: 'no_action', signals };
}

/**
 * Given a list of severities, return the highest per SEVERITY_PRIORITY.
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
 * Given a list of recommendations, return the highest per
 * RECOMMENDATION_PRIORITY.
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
 * Build reviewer action strings. Always ends with the standard disclaimer.
 * Includes a per-missed-or-late critical item sentence.
 */
export function buildPathwayActions({ recommendation, severity, itemResults = [] } = {}) {
  const actions = [];
  const results = asArray(itemResults);
  const norm = (s) => String(s || '').trim();
  const rec = RECOMMENDATIONS.has(norm(recommendation)) ? norm(recommendation) : 'unknown';
  const sev = SEVERITIES.has(norm(severity)) ? norm(severity) : 'unknown';

  switch (rec) {
    case 'critical_miss':
      actions.push('Critical pathway item missed — escalate immediately to the treating clinician for bedside review.');
      break;
    case 'escalate':
      actions.push('Pathway compliance gap requires escalation to the treating clinician.');
      break;
    case 'review_pathway':
      actions.push('Overall pathway compliance is low — review the patient-specific pathway plan with the team.');
      break;
    case 'catch_up':
      actions.push('Catch up on outstanding pathway items per the evaluator summary.');
      break;
    case 'no_action':
      actions.push('Pathway compliance meets expectations — continue monitoring.');
      break;
    default:
      actions.push('Pathway status is unclear — review inputs and re-evaluate.');
      break;
  }

  // Per-critical-item sentence for missed or late criticals.
  for (const result of results) {
    if (!result || result.critical !== true) continue;
    if (result.status === 'missed') {
      actions.push(`Critical item "${result.display || result.item_key}" (${result.item_key}) is missed — confirm bedside status and escalate.`);
    } else if (result.status === 'late') {
      const delta = Number.isFinite(Number(result.delta_minutes)) ? ` (delta ${result.delta_minutes} min)` : '';
      actions.push(`Critical item "${result.display || result.item_key}" (${result.item_key}) is late${delta} — confirm action and document rationale.`);
    }
  }

  // De-duplicate & clean before appending disclaimer.
  const seen = new Set();
  const deduped = [];
  for (const line of actions) {
    const cleaned = cleanText(line);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned);
  }

  // Keep severity label in context-free suffix (optional but useful).
  if (sev !== 'unknown' && sev !== 'low') {
    deduped.push(`Review severity is ${sev}.`);
  }

  deduped.push(REVIEW_DISCLAIMER);
  return deduped;
}

/**
 * One-sentence human summary of a pathway audit.
 */
export function summarizePathwayAudit({
  pathwayKey,
  compliancePct,
  severity,
  recommendation,
} = {}) {
  const key = cleanText(pathwayKey) || 'pathway';
  const pct = Number.isFinite(Number(compliancePct)) ? round2(Number(compliancePct)) : 0;
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const rec = RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown';
  return `${key}: compliance ${pct}% — severity ${sev}, recommendation ${rec}.`;
}

// ---------- DB glue (generation / audit row / review) --------------------

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
  admissionId,
  patientUid,
  prompt,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
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
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
               $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
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
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      aiResult?.latencyMs || usage.latency_ms || null,
      aiResult?.requestId || usage.provider_request_id || null,
      aiResult?.finishReason || usage.finish_reason || null,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Pathway bundle compliance: generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'NURSE', 'ADMIN'],
        source: 'pathway_bundle_compliance',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Pathway bundle compliance: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildSafetyFlagsFor({ recommendation, citations }) {
  const flags = [];
  if (recommendation === 'critical_miss') {
    flags.push({
      severity: 'critical',
      code: 'PATHWAY_CRITICAL_MISS',
      message: 'Critical pathway item missed — immediate clinician review required before any action.',
    });
  } else if (recommendation === 'escalate') {
    flags.push({
      severity: 'high',
      code: 'PATHWAY_ESCALATE',
      message: 'Pathway compliance gap requires clinician escalation.',
    });
  }
  if (!citations || !citations.length) {
    flags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Pathway bundle audit has no source citations.',
    });
  }
  return flags;
}

// ---------- Public API --------------------------------------------------

/**
 * Evaluate a clinical pathway bundle for a patient and persist a reviewable
 * audit. Review-only — the service never administers medication or places
 * orders.
 */
export async function evaluatePathwayBundle({
  req = null,
  patientUid,
  admissionId = null,
  pathwayKey,
  customSpec = null,
  t0Reference,
  actions = [],
  context = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const cleanedPathwayKey = cleanText(pathwayKey);
  if (!cleanedPathwayKey) {
    throw AppError.badRequest('pathway_key is required');
  }
  const t0Date = parseTimestamp(t0Reference);
  if (!t0Date) {
    throw AppError.badRequest('t0_reference is required and must be a parseable timestamp');
  }
  const safeAdmissionId = admissionId ? optionalInt(admissionId, 'admission_id') : null;

  // Pure rule-based evaluation.
  const evaluation = evaluateBundle({
    pathwayKey: cleanedPathwayKey,
    customSpec,
    t0Reference: t0Date,
    actions,
    context,
  });
  const severityRec = classifySeverityAndRecommendation({
    itemResults: evaluation.item_results,
    compliancePct: evaluation.compliance_pct,
  });

  // WS5 B5.5 — curated knowledge-base grounding. ADDITIVE + GATED via the
  // module's settings.knowledgeBases (clinical_guideline / sop). Graceful:
  // no chunks / KB down → citations + prompt unchanged. Rule-based
  // compliance scoring stays authoritative; KB only grounds the narrative.
  const kbGrounding = await groundWithKnowledgeBases({
    module,
    tenantId,
    queryText: [
      evaluation.pathway_display,
      evaluation.pathway_key,
      asArray(evaluation.item_results).map((item) => item.display || item.item_key).slice(0, 8).join(' '),
    ].filter(Boolean).join('. '),
    role: req?.user?.role || null,
    retrievedBy: req?.user?.uid || null,
    moduleKey: MODULE_KEY,
  });

  // baseCitations = rule-derived citations ONLY (NO curated KB). The
  // NO_CITATIONS fail-close in buildSafetyFlagsFor is evaluated on these
  // alone, so a curated-KB citation can NEVER satisfy a gate that must
  // require chart/rule grounding.
  const baseCitations = uniqueCitations([
    {
      source_type: 'patient',
      source_id: String(patientUid),
      label: 'Patient record',
      timestamp: null,
    },
    {
      source_type: 'pathway_preset',
      source_id: evaluation.pathway_key,
      label: `Pathway preset — ${evaluation.pathway_display}`,
      timestamp: null,
    },
    {
      source_type: 'pathway_bundle_rules',
      source_id: MODULE_KEY,
      label: 'Pathway bundle rules engine',
      timestamp: null,
    },
    ...asArray(actions).map((action, idx) => ({
      source_type: 'pathway_action',
      source_id: `${cleanText(action?.item_key) || 'item'}:${idx}`,
      label: `Action — ${cleanText(action?.item_key) || 'unknown'}`,
      timestamp: action?.occurred_at || action?.action_at || action?.timestamp || null,
    })),
  ]);
  // Full citation set (base + KB) that is persisted, returned, and displayed.
  // KB chunks stay visible for traceability but never gate fail-close.
  const citations = uniqueCitations([
    ...baseCitations,
    ...kbGrounding.citations,
  ]);

  const baseFlags = buildSafetyFlagsFor({
    recommendation: severityRec.recommendation,
    citations: baseCitations,
  });

  const recommendedActions = buildPathwayActions({
    recommendation: severityRec.recommendation,
    severity: severityRec.severity,
    itemResults: evaluation.item_results,
  });

  const summary = summarizePathwayAudit({
    pathwayKey: evaluation.pathway_key,
    compliancePct: evaluation.compliance_pct,
    severity: severityRec.severity,
    recommendation: severityRec.recommendation,
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid,
    admission_id: safeAdmissionId,
    pathway_key: evaluation.pathway_key,
    pathway_display: evaluation.pathway_display,
    t0_reference: t0Date.toISOString(),
    compliance_pct: evaluation.compliance_pct,
    compliant_count: evaluation.compliant_count,
    late_count: evaluation.late_count,
    missed_count: evaluation.missed_count,
    na_count: evaluation.na_count,
    item_results: evaluation.item_results,
    severity: severityRec.severity,
    recommendation: severityRec.recommendation,
    signals: severityRec.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: citations,
    safety_flags: baseFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // AI narrative (decorative only — never overrides rule outputs).
  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        rules_authoritative: true,
        decision_support_only: true,
        pathway_key: evaluation.pathway_key,
        pathway_display: evaluation.pathway_display,
        t0_reference: t0Date.toISOString(),
        rule_based_evaluation: evaluation,
        severity: severityRec.severity,
        recommendation: severityRec.recommendation,
        signals: severityRec.signals,
        ...(kbGrounding.used ? { curated_knowledge: kbGrounding.groundingChunks } : {}),
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Pathway bundle compliance: AI narrative failed (non-fatal)', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = {
    ...fallbackDraft,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed?.source_citations),
    ]),
  };

  const combinedFlags = [
    ...baseFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        patient: { uid: patientUid },
        pathway: { key: evaluation.pathway_key, display: evaluation.pathway_display },
        t0_reference: t0Date.toISOString(),
      },
      citations,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid,
    prompt,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid,
      admission_id: safeAdmissionId,
      pathway_key: evaluation.pathway_key,
      t0_reference: t0Date.toISOString(),
      item_results: evaluation.item_results,
    }),
    draft,
    citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      pathway_key: evaluation.pathway_key,
      severity: severityRec.severity,
      recommendation: severityRec.recommendation,
      compliance_pct: evaluation.compliance_pct,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  let auditRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_pathway_bundle_audits
         (tenant_id, patient_uid, admission_id, pathway_key, pathway_display,
          t0_reference, generation_id, compliance_pct, compliant_count,
          late_count, missed_count, na_count, item_results, severity,
          recommendation, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10,
               $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17, $18::jsonb,
               $19::jsonb, $20::jsonb, 'pending', $21::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, pathway_key,
                 pathway_display, t0_reference, evaluated_at, generation_id,
                 compliance_pct, compliant_count, late_count, missed_count,
                 na_count, item_results, severity, recommendation, signals,
                 summary, recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      safeAdmissionId,
      evaluation.pathway_key,
      evaluation.pathway_display,
      t0Date.toISOString(),
      generation?.id || null,
      evaluation.compliance_pct,
      evaluation.compliant_count,
      evaluation.late_count,
      evaluation.missed_count,
      evaluation.na_count,
      JSON.stringify(evaluation.item_results),
      SEVERITIES.has(severityRec.severity) ? severityRec.severity : 'unknown',
      RECOMMENDATIONS.has(severityRec.recommendation) ? severityRec.recommendation : 'unknown',
      JSON.stringify(severityRec.signals),
      draft.summary,
      JSON.stringify(recommendedActions),
      JSON.stringify(citations),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    auditRow = (rows && rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        audit_id: null,
        generation_id: generation?.id || null,
        clinical_review_id: null,
        draft,
        audit: null,
        pathway_key: evaluation.pathway_key,
        compliance_pct: evaluation.compliance_pct,
        compliant_count: evaluation.compliant_count,
        late_count: evaluation.late_count,
        missed_count: evaluation.missed_count,
        na_count: evaluation.na_count,
        item_results: evaluation.item_results,
        severity: severityRec.severity,
        recommendation: severityRec.recommendation,
        signals: severityRec.signals,
        source_citations: citations,
        safety_flags: combinedFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_pathway_bundle_audits_unavailable',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
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
    throw err;
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.pathway_bundle_evaluated',
      aggregateType: 'clinical_ai_pathway_bundle_audit',
      aggregateId: auditRow?.id || generation?.id || null,
      patientUid,
      payload: {
        tenant_id: tenantId,
        admission_id: safeAdmissionId,
        audit_id: auditRow?.id || null,
        generation_id: generation?.id || null,
        pathway_key: evaluation.pathway_key,
        compliance_pct: evaluation.compliance_pct,
        severity: severityRec.severity,
        recommendation: severityRec.recommendation,
        compliant_count: evaluation.compliant_count,
        late_count: evaluation.late_count,
        missed_count: evaluation.missed_count,
        na_count: evaluation.na_count,
      },
    });
  } catch (err) {
    logger.warn('Pathway bundle compliance: event publish failed', { error: err?.message });
  }

  return {
    audit_id: auditRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    audit: auditRow,
    pathway_key: evaluation.pathway_key,
    compliance_pct: evaluation.compliance_pct,
    compliant_count: evaluation.compliant_count,
    late_count: evaluation.late_count,
    missed_count: evaluation.missed_count,
    na_count: evaluation.na_count,
    item_results: evaluation.item_results,
    severity: severityRec.severity,
    recommendation: severityRec.recommendation,
    signals: severityRec.signals,
    source_citations: citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || auditRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
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

export async function listPathwayBundleAudits({
  tenantId = null,
  patientUid = null,
  pathwayKey = null,
  severity = null,
  recommendation = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSeverity =
    severity && SEVERITIES.has(cleanText(severity).toLowerCase())
      ? cleanText(severity).toLowerCase()
      : null;
  const normalizedRecommendation =
    recommendation && RECOMMENDATIONS.has(cleanText(recommendation).toLowerCase())
      ? cleanText(recommendation).toLowerCase()
      : null;
  const normalizedDecision =
    reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
      ? cleanText(reviewerDecision).toLowerCase()
      : null;
  const normalizedPathway = pathwayKey ? cleanText(pathwayKey) : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.patient_uid, u.name AS patient_name,
              a.admission_id, a.pathway_key, a.pathway_display, a.t0_reference,
              a.evaluated_at, a.generation_id, a.compliance_pct,
              a.compliant_count, a.late_count, a.missed_count, a.na_count,
              a.item_results, a.severity, a.recommendation, a.signals,
              a.summary, a.recommended_actions, a.source_citations,
              a.safety_flags, a.reviewer_decision, a.reviewed_by, a.reviewed_at,
              a.reviewer_note, a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_pathway_bundle_audits a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR a.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR a.pathway_key = $3)
         AND ($4::text IS NULL OR a.severity = $4)
         AND ($5::text IS NULL OR a.recommendation = $5)
         AND ($6::text IS NULL OR a.reviewer_decision = $6)
       ORDER BY
         CASE a.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $7`,
      tid,
      patientUid || null,
      normalizedPathway,
      normalizedSeverity,
      normalizedRecommendation,
      normalizedDecision,
      safeLimit
    );
    return { audits: asArray(rows), count: asArray(rows).length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { audits: [], count: 0 };
    throw err;
  }
}

export async function decidePathwayBundleAudit({
  tenantId = null,
  auditId,
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
    `UPDATE clinical_ai_pathway_bundle_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, patient_uid, admission_id, pathway_key,
               pathway_display, t0_reference, evaluated_at, generation_id,
               compliance_pct, compliant_count, late_count, missed_count,
               na_count, item_results, severity, recommendation, signals,
               summary, recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(auditId, 'audit_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Pathway bundle audit not found');
  const row = rows[0];
  return {
    ...row,
    compliance_pct: toNumber(row.compliance_pct, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

export default {
  PATHWAY_PRESETS,
  ITEM_STATUSES,
  RECOMMENDATIONS,
  RECOMMENDATION_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  DECISIONS,
  FINAL_DECISIONS,
  getPathwaySpec,
  classifyItemStatus,
  evaluateBundle,
  classifySeverityAndRecommendation,
  escalateSeverity,
  escalateRecommendation,
  buildPathwayActions,
  summarizePathwayAudit,
  evaluatePathwayBundle,
  listPathwayBundleAudits,
  decidePathwayBundleAudit,
};
