/**
 * Inventory Intelligence (Non-Pharmacy).
 *
 * Decision-support module covering non-pharmacy hospital inventory (PPE,
 * linens, surgical instruments, consumables, biomedical single-use items,
 * housekeeping supplies). For each item, reviews current stock, average
 * daily consumption, reorder point, stockout days-on-hand, expiry dates,
 * and recent consumption anomaly vs historical baseline. Outputs an alert
 * classification: stockout_risk / reorder_point_breach / overstock /
 * expiry_risk / consumption_anomaly / healthy.
 *
 * Rules are authoritative. Review-only: the materials manager approves
 * every action. The module never places or cancels orders automatically.
 *
 * Graceful degradation: if the inventory-alerts schema is missing, the
 * service returns a schema_unavailable payload rather than crashing.
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

const MODULE_KEY = 'inventory_intelligence';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support materials-manager review of non-pharmacy hospital inventory (PPE, linens, surgical instruments, consumables, biomed single-use items, housekeeping supplies). Rules are authoritative. Return JSON only and never place or cancel purchase orders. Do not infer drug/pharmacy items — this module is non-pharmacy.',
  user_prompt_template:
    'Given the non-pharmacy inventory context and the rule-based alert classification, return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not override alert_category or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const ALERT_CATEGORIES = new Set([
  'stockout_risk',
  'reorder_point_breach',
  'overstock',
  'expiry_risk',
  'consumption_anomaly',
  'healthy',
  'unknown',
]);

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

// Priority: higher index = higher priority.
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const CATEGORY_PRIORITY = [
  'unknown',
  'healthy',
  'overstock',
  'consumption_anomaly',
  'reorder_point_breach',
  'expiry_risk',
  'stockout_risk',
];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Materials manager review required — decision support only; no orders are placed automatically.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Stockout days-on-hand:
 *  - avgDailyUsage <= 0 → null (effectively infinite; can't forecast)
 *  - currentStock < 0 → 0
 *  - otherwise: currentStock / avgDailyUsage, rounded to 2 decimals,
 *    clamped 0..9999.
 */
export function computeDaysOnHand({ currentStock, avgDailyUsage } = {}) {
  const stock = toNumber(currentStock, 0);
  const usage = toNumber(avgDailyUsage, 0);
  if (usage <= 0) return null;
  if (stock < 0) return 0;
  const raw = stock / usage;
  const clamped = Math.max(0, Math.min(9999, raw));
  return round2(clamped);
}

/**
 * UTC-day diff from `today` to `nextExpiryDate`.
 *   - null / missing → null
 *   - past date → negative integer
 *   - otherwise → integer number of whole UTC days
 */
export function computeDaysToExpiry({ nextExpiryDate, today = null } = {}) {
  if (nextExpiryDate === null || nextExpiryDate === undefined) return null;
  const expiryDate = toDateOnly(nextExpiryDate);
  if (!expiryDate) return null;
  const todayDate = today ? toDateOnly(today) : new Date();
  if (!todayDate) return null;
  const expiryUtc = Date.UTC(
    expiryDate.getUTCFullYear(),
    expiryDate.getUTCMonth(),
    expiryDate.getUTCDate()
  );
  const todayUtc = Date.UTC(
    todayDate.getUTCFullYear(),
    todayDate.getUTCMonth(),
    todayDate.getUTCDate()
  );
  const diffMs = expiryUtc - todayUtc;
  return Math.trunc(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Signed percentage delta of current vs baseline daily usage.
 *   - baseline <= 0 → 0
 *   - otherwise: ((avg - baseline) / baseline) * 100, clamped to -500..+500,
 *     rounded to 2 decimals.
 */
export function computeConsumptionDeviationPct({ avgDailyUsage, baselineDailyUsage } = {}) {
  const avg = toNumber(avgDailyUsage, 0);
  const baseline = toNumber(baselineDailyUsage, 0);
  if (baseline <= 0) return 0;
  const pct = ((avg - baseline) / baseline) * 100;
  const clamped = Math.max(-500, Math.min(500, pct));
  return round2(clamped);
}

/**
 * Stock band classifier:
 *   currentStock <= 0           → 'out'
 *   currentStock < reorderPoint → 'below_reorder'
 *   maxStock set and currentStock > maxStock * 1.2 → 'over_max'
 *   otherwise                   → 'ok'
 */
export function classifyStockBand({ currentStock, reorderPoint = 0, maxStock = null } = {}) {
  const stock = toNumber(currentStock, 0);
  const reorder = toNumber(reorderPoint, 0);
  const max = toNullableNumber(maxStock);
  if (stock <= 0) return 'out';
  if (stock < reorder) return 'below_reorder';
  if (max !== null && max > 0 && stock > max * 1.2) return 'over_max';
  return 'ok';
}

/**
 * Days-on-hand band classifier:
 *   null → 'unknown'
 *   doh < 2 → 'critical' (stockout imminent)
 *   doh < 5 → 'warning'
 *   doh < 14 → 'watch'
 *   doh <= 60 → 'ok'
 *   doh > 60 → 'excess'
 */
export function classifyDaysOnHandBand(doh) {
  if (doh === null || doh === undefined) return 'unknown';
  const v = toNumber(doh, null);
  if (v === null || !Number.isFinite(v)) return 'unknown';
  if (v < 2) return 'critical';
  if (v < 5) return 'warning';
  if (v < 14) return 'watch';
  if (v <= 60) return 'ok';
  return 'excess';
}

/**
 * Days-to-expiry band classifier:
 *   null → 'unknown'
 *   daysToExpiry < 0 → 'expired'
 *   daysToExpiry <= 14 → 'imminent'
 *   daysToExpiry <= 30 → 'warning'
 *   daysToExpiry <= 90 → 'watch'
 *   else → 'ok'
 */
export function classifyExpiryBand(daysToExpiry) {
  if (daysToExpiry === null || daysToExpiry === undefined) return 'unknown';
  const v = toNumber(daysToExpiry, null);
  if (v === null || !Number.isFinite(v)) return 'unknown';
  if (v < 0) return 'expired';
  if (v <= 14) return 'imminent';
  if (v <= 30) return 'warning';
  if (v <= 90) return 'watch';
  return 'ok';
}

/**
 * Consumption anomaly classifier (based on signed deviation %).
 *   abs(dev) < 20 → 'normal'
 *   abs(dev) < 40 → 'elevated'
 *   dev >= 40 → 'surge'
 *   dev <= -40 → 'drop'
 *   else → 'normal'
 */
export function classifyConsumptionAnomaly(deviationPct) {
  const dev = toNumber(deviationPct, 0);
  const mag = Math.abs(dev);
  if (mag < 20) return 'normal';
  if (mag < 40) return 'elevated';
  if (dev >= 40) return 'surge';
  if (dev <= -40) return 'drop';
  return 'normal';
}

/**
 * Escalate a list of severity strings to the highest per SEVERITY_PRIORITY.
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
 * Escalate a list of category strings to the highest per CATEGORY_PRIORITY.
 */
export function escalateCategory(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = CATEGORY_PRIORITY.indexOf('unknown');
  for (const cat of arr) {
    const normalized = ALERT_CATEGORIES.has(cat) ? cat : 'unknown';
    const idx = CATEGORY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Classify an inventory record into an alert_category + severity + signal list.
 *
 * Accepts either precomputed bands (stockBand, dohBand, expiryBand,
 * anomalyBand) or raw metrics (currentStock, reorderPoint, maxStock,
 * daysOnHand, daysToExpiry, deviationPct). Missing bands are derived from
 * the supplied raw metrics.
 *
 * Rules-authoritative: the highest-priority alert category (per
 * CATEGORY_PRIORITY) wins. All matched signals are aggregated.
 *
 * Returns { alert_category, severity, signals: [{ code, detail? }] }.
 */
export function classifyInventoryAlert(metrics = {}) {
  const {
    currentStock = 0,
    reorderPoint = 0,
    maxStock = null,
    daysOnHand = null,
    daysToExpiry = null,
    deviationPct = 0,
  } = metrics;

  const stockBand = metrics.stockBand
    || classifyStockBand({ currentStock, reorderPoint, maxStock });
  const dohBand = metrics.dohBand || classifyDaysOnHandBand(daysOnHand);
  const expiryBand = metrics.expiryBand || classifyExpiryBand(daysToExpiry);
  const anomalyBand = metrics.anomalyBand || classifyConsumptionAnomaly(deviationPct);

  // Candidate (category, severity, signal) tuples — all matched rules emit.
  const categoryCandidates = [];
  const severityCandidates = [];
  const signals = [];

  const pushSignal = (code, detail) => {
    signals.push(detail ? { code, detail } : { code });
  };

  // stockBand === 'out' → stockout_risk / critical
  if (stockBand === 'out') {
    categoryCandidates.push('stockout_risk');
    severityCandidates.push('critical');
    pushSignal('STOCKOUT_ZERO', 'Current stock is zero or negative.');
  }

  // dohBand === 'critical' → stockout_risk / critical
  if (dohBand === 'critical') {
    categoryCandidates.push('stockout_risk');
    severityCandidates.push('critical');
    pushSignal('STOCKOUT_IMMINENT', 'Days-on-hand below 2 days; stockout imminent.');
  }

  // dohBand === 'warning' AND stockBand !== 'over_max' → reorder_point_breach / high
  if (dohBand === 'warning' && stockBand !== 'over_max') {
    categoryCandidates.push('reorder_point_breach');
    severityCandidates.push('high');
    pushSignal('LOW_DOH', 'Days-on-hand below 5 days; trigger reorder.');
  }

  // stockBand === 'below_reorder' → reorder_point_breach / moderate-or-higher
  if (stockBand === 'below_reorder') {
    categoryCandidates.push('reorder_point_breach');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'moderate']));
    pushSignal('BELOW_REORDER', 'Current stock below reorder point.');
  }

  // expiryBand === 'expired' → expiry_risk / critical
  if (expiryBand === 'expired') {
    categoryCandidates.push('expiry_risk');
    severityCandidates.push('critical');
    pushSignal('ITEM_EXPIRED', 'Earliest lot past expiry date.');
  }

  // expiryBand === 'imminent' → expiry_risk / high-or-higher
  if (expiryBand === 'imminent') {
    categoryCandidates.push('expiry_risk');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'high']));
    pushSignal('EXPIRY_IMMINENT', 'Expiry within 14 days.');
  }

  // expiryBand === 'warning' → expiry_risk / moderate-or-higher
  if (expiryBand === 'warning') {
    categoryCandidates.push('expiry_risk');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'moderate']));
    pushSignal('EXPIRY_WARNING', 'Expiry within 30 days.');
  }

  // stockBand === 'over_max' OR dohBand === 'excess' → overstock / moderate-or-higher
  if (stockBand === 'over_max' || dohBand === 'excess') {
    categoryCandidates.push('overstock');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'moderate']));
    pushSignal('OVERSTOCK', 'Stock exceeds max or days-on-hand > 60 days.');
  }

  // anomalyBand === 'surge' → consumption_anomaly / moderate-or-higher
  if (anomalyBand === 'surge') {
    categoryCandidates.push('consumption_anomaly');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'moderate']));
    pushSignal('CONSUMPTION_SURGE', 'Average daily usage >= 40% above baseline.');
  }

  // anomalyBand === 'drop' → consumption_anomaly / low-or-higher
  if (anomalyBand === 'drop') {
    categoryCandidates.push('consumption_anomaly');
    severityCandidates.push(escalateSeverity([...severityCandidates, 'low']));
    pushSignal('CONSUMPTION_DROP', 'Average daily usage >= 40% below baseline.');
  }

  // Default: healthy.
  if (!categoryCandidates.length) {
    categoryCandidates.push('healthy');
    severityCandidates.push('low');
    pushSignal('HEALTHY', 'All bands within healthy operating range.');
  }

  const final_category = escalateCategory(categoryCandidates);
  const final_severity = escalateSeverity(severityCandidates);

  const alert_category = ALERT_CATEGORIES.has(final_category) ? final_category : 'unknown';
  const severity = SEVERITIES.has(final_severity) ? final_severity : 'unknown';

  return {
    alert_category,
    severity,
    signals,
  };
}

/**
 * Build reviewer-facing actions for the alert. Always ends with the
 * materials-manager disclaimer.
 */
export function buildInventoryActions({ alertCategory, signals = [], itemName = null } = {}) {
  const name = cleanText(itemName) || 'this item';
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (alertCategory) {
    case 'stockout_risk':
      push(`Create an urgent reorder request for ${name} with supply chain.`);
      push(`Check nearby wards for loaner stock of ${name} and coordinate transfer while the reorder is in flight.`);
      push('Notify clinical leads so substitution / deferral plans can be discussed if stockout is unavoidable.');
      break;
    case 'reorder_point_breach':
      push(`Submit a standard reorder request for ${name} to supply chain.`);
      push('Verify supplier lead time and confirm the next delivery window covers projected usage.');
      break;
    case 'expiry_risk':
      push(`Rotate or reassign lots of ${name} nearing expiry to high-turnover wards before waste occurs.`);
      push('Quarantine and document any expired lots per the expired-stock SOP; do not dispense expired inventory.');
      break;
    case 'overstock':
      push(`Pause or defer pending reorders of ${name} until days-on-hand returns to normal range.`);
      push('Review procurement cadence and min/max levels with supply chain.');
      break;
    case 'consumption_anomaly':
      push(`Investigate the unusual consumption pattern for ${name} — confirm whether it reflects a real usage change or a data-entry issue.`);
      push('Notify the ward lead so the baseline can be updated if the new usage level is expected.');
      break;
    case 'healthy':
    default:
      push(`${name} is within healthy operating range; continue routine monitoring.`);
      break;
  }

  // Map from matched signal codes to supplementary actions.
  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'EXPIRY_IMMINENT') {
      push('Prioritize expiring lots in the next cycle count; flag in the ward handover log.');
    } else if (code === 'ITEM_EXPIRED') {
      push('Remove expired lots from usable stock immediately and log in the wastage register.');
    } else if (code === 'LOW_DOH' || code === 'STOCKOUT_IMMINENT') {
      push('Escalate to the materials manager on call; expedite shipping if possible.');
    } else if (code === 'OVERSTOCK') {
      push('Offer excess stock to other wards or networked facilities before expiry approaches.');
    } else if (code === 'CONSUMPTION_SURGE') {
      push('Adjust short-term par levels to cover the surge while the investigation is underway.');
    } else if (code === 'CONSUMPTION_DROP') {
      push('Check whether usage dropped because the item was substituted or the procedure volume changed.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary for the alert row.
 */
export function summarizeInventory({
  itemName,
  alertCategory,
  severity,
  currentStock,
  reorderPoint,
  daysOnHand,
  daysToExpiry,
} = {}) {
  const name = cleanText(itemName) || 'item';
  const cat = ALERT_CATEGORIES.has(alertCategory) ? alertCategory : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const dohText = daysOnHand === null || daysOnHand === undefined
    ? 'DOH n/a'
    : `DOH ${toNumber(daysOnHand, 0)}d`;
  const expiryText = daysToExpiry === null || daysToExpiry === undefined
    ? null
    : `expiry in ${toNumber(daysToExpiry, 0)}d`;
  const parts = [
    `${name}: ${cat.replace(/_/g, ' ')} (${sev})`,
    `stock ${toNumber(currentStock, 0)} / reorder ${toNumber(reorderPoint, 0)}`,
    dohText,
  ];
  if (expiryText) parts.push(expiryText);
  return `${parts.join(', ')}.`;
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
      logger.warn('Inventory intelligence generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, itemSku, module }) {
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'MATERIALS_MANAGER', 'PHARMACY_STAFF'],
        source: 'inventory_intelligence',
        item_sku: itemSku || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
        non_pharmacy_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Inventory intelligence review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeAlertRow(row) {
  if (!row) return row;
  return {
    ...row,
    current_stock: row.current_stock !== null && row.current_stock !== undefined
      ? toNumber(row.current_stock, 0)
      : 0,
    reorder_point: row.reorder_point !== null && row.reorder_point !== undefined
      ? toNumber(row.reorder_point, 0)
      : 0,
    max_stock: row.max_stock !== null && row.max_stock !== undefined
      ? toNumber(row.max_stock, null)
      : null,
    avg_daily_usage: row.avg_daily_usage !== null && row.avg_daily_usage !== undefined
      ? toNumber(row.avg_daily_usage, 0)
      : 0,
    baseline_daily_usage: row.baseline_daily_usage !== null && row.baseline_daily_usage !== undefined
      ? toNumber(row.baseline_daily_usage, 0)
      : 0,
    days_on_hand: row.days_on_hand !== null && row.days_on_hand !== undefined
      ? toNumber(row.days_on_hand, null)
      : null,
    days_to_expiry: row.days_to_expiry !== null && row.days_to_expiry !== undefined
      ? toNumber(row.days_to_expiry, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertInventoryAlert({
  tenantId,
  itemSku,
  itemName,
  category,
  ward,
  generationId,
  currentStock,
  reorderPoint,
  maxStock,
  avgDailyUsage,
  baselineDailyUsage,
  daysOnHand,
  nextExpiryDate,
  daysToExpiry,
  alertCategory,
  severity,
  signals,
  summary,
  recommendedActions,
  sourceCitations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_inventory_alerts
         (tenant_id, item_sku, item_name, category, ward, generation_id,
          current_stock, reorder_point, max_stock, avg_daily_usage,
          baseline_daily_usage, days_on_hand, next_expiry_date, days_to_expiry,
          alert_category, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               $11, $12, $13::date, $14,
               $15, $16, $17::jsonb, $18, $19::jsonb,
               $20::jsonb, $21::jsonb, 'pending', $22::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, item_sku, item_name, category, ward, generation_id,
                 current_stock, reorder_point, max_stock, avg_daily_usage,
                 baseline_daily_usage, days_on_hand, next_expiry_date, days_to_expiry,
                 alert_category, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      itemSku,
      itemName,
      category,
      ward,
      generationId,
      currentStock,
      reorderPoint,
      maxStock,
      avgDailyUsage,
      baselineDailyUsage,
      daysOnHand,
      nextExpiryDate,
      daysToExpiry,
      ALERT_CATEGORIES.has(alertCategory) ? alertCategory : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      JSON.stringify(asArray(signals)),
      summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(sourceCitations)),
      JSON.stringify(asArray(safetyFlags)),
      JSON.stringify(metadata || {})
    );
    return normalizeAlertRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateInventoryItem({
  req = null,
  itemSku,
  itemName,
  category = null,
  ward = null,
  currentStock,
  reorderPoint = 0,
  maxStock = null,
  avgDailyUsage = 0,
  baselineDailyUsage = 0,
  nextExpiryDate = null,
  today = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  // Validate inputs.
  const sku = cleanText(itemSku);
  if (!sku) throw AppError.badRequest('item_sku is required');
  const name = cleanText(itemName);
  if (!name) throw AppError.badRequest('item_name is required');
  if (currentStock === null || currentStock === undefined || currentStock === '') {
    throw AppError.badRequest('current_stock is required');
  }
  const stock = Number(currentStock);
  if (!Number.isFinite(stock)) {
    throw AppError.badRequest('current_stock must be a finite number');
  }

  const reorder = toNumber(reorderPoint, 0);
  const max = toNullableNumber(maxStock);
  const avgUsage = toNumber(avgDailyUsage, 0);
  const baselineUsage = toNumber(baselineDailyUsage, 0);
  const safeCategory = category ? cleanText(category) : null;
  const safeWard = ward ? cleanText(ward) : null;
  const expiryDateIso = nextExpiryDate ? (() => {
    const d = toDateOnly(nextExpiryDate);
    return d ? d.toISOString().slice(0, 10) : null;
  })() : null;

  // Compute metrics.
  const daysOnHand = computeDaysOnHand({ currentStock: stock, avgDailyUsage: avgUsage });
  const daysToExpiry = computeDaysToExpiry({ nextExpiryDate: expiryDateIso, today });
  const deviationPct = computeConsumptionDeviationPct({
    avgDailyUsage: avgUsage,
    baselineDailyUsage: baselineUsage,
  });

  // Classify.
  const classification = classifyInventoryAlert({
    currentStock: stock,
    reorderPoint: reorder,
    maxStock: max,
    daysOnHand,
    daysToExpiry,
    deviationPct,
  });

  const recommendedActions = buildInventoryActions({
    alertCategory: classification.alert_category,
    signals: classification.signals,
    itemName: name,
  });

  const summary = summarizeInventory({
    itemName: name,
    alertCategory: classification.alert_category,
    severity: classification.severity,
    currentStock: stock,
    reorderPoint: reorder,
    daysOnHand,
    daysToExpiry,
  });

  // Citations.
  const citations = [
    {
      source_type: 'inventory_record',
      source_id: sku,
      label: `Inventory — ${name} (${sku})`,
      timestamp: null,
    },
    {
      source_type: 'inventory_item',
      source_id: sku,
      label: `Item ${name}`,
      timestamp: null,
    },
  ];
  if (safeWard) {
    citations.push({
      source_type: 'ward',
      source_id: safeWard,
      label: `Ward — ${safeWard}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'inventory_rules',
    source_id: MODULE_KEY,
    label: 'Non-pharmacy inventory rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'INVENTORY_CRITICAL',
      message: 'Critical inventory alert — notify the materials manager immediately.',
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'INVENTORY_NO_CITATIONS',
      message: 'Inventory alert has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'INVENTORY_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — materials manager reviews and approves every order.',
  });

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    item_sku: sku,
    item_name: name,
    category: safeCategory,
    ward: safeWard,
    inputs: {
      current_stock: stock,
      reorder_point: reorder,
      max_stock: max,
      avg_daily_usage: avgUsage,
      baseline_daily_usage: baselineUsage,
      next_expiry_date: expiryDateIso,
    },
    metrics: {
      days_on_hand: daysOnHand,
      days_to_expiry: daysToExpiry,
      consumption_deviation_pct: deviationPct,
    },
    alert_category: classification.alert_category,
    severity: classification.severity,
    signals: classification.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
    non_pharmacy_only: true,
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
        item: { item_sku: sku, item_name: name, category: safeCategory, ward: safeWard },
        inputs: fallbackDraft.inputs,
        metrics: fallbackDraft.metrics,
        rule_based_evaluation: {
          alert_category: classification.alert_category,
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
    logger.debug('Inventory intelligence AI narrative unavailable; using template fallback', {
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
        item: { sku, name, category: safeCategory, ward: safeWard },
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
      item_sku: sku,
      item_name: name,
      ward: safeWard,
      category: safeCategory,
      inputs: fallbackDraft.inputs,
      alert_category: classification.alert_category,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      item_sku: sku,
      category: safeCategory,
      ward: safeWard,
      alert_category: classification.alert_category,
      severity: classification.severity,
      signal_codes: classification.signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
      non_pharmacy_only: true,
    },
  });

  // Persist inventory alert row.
  const alertRow = await insertInventoryAlert({
    tenantId,
    itemSku: sku,
    itemName: name,
    category: safeCategory,
    ward: safeWard,
    generationId: generation?.id || null,
    currentStock: stock,
    reorderPoint: reorder,
    maxStock: max,
    avgDailyUsage: avgUsage,
    baselineDailyUsage: baselineUsage,
    daysOnHand,
    nextExpiryDate: expiryDateIso,
    daysToExpiry,
    alertCategory: classification.alert_category,
    severity: classification.severity,
    signals: classification.signals,
    summary: draft.summary,
    recommendedActions,
    sourceCitations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      consumption_deviation_pct: deviationPct,
      rules_authoritative: true,
      decision_support_only: true,
      non_pharmacy_only: true,
    },
  });

  if (!alertRow) {
    return {
      alert_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      alert_category: classification.alert_category,
      severity: classification.severity,
      signals: classification.signals,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_inventory_alerts_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  // Review placeholder.
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    itemSku: sku,
    module,
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.inventory_alert_generated',
      aggregateType: 'clinical_ai_inventory_alert',
      aggregateId: alertRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        alert_id: alertRow.id,
        generation_id: generation?.id || null,
        item_sku: sku,
        item_name: name,
        category: safeCategory,
        ward: safeWard,
        alert_category: classification.alert_category,
        severity: classification.severity,
        signal_codes: classification.signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Inventory intelligence event publish failed', { error: err?.message });
  }

  return {
    alert_id: alertRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    alert: alertRow,
    alert_category: classification.alert_category,
    severity: classification.severity,
    signals: classification.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || alertRow.reviewer_decision || 'pending',
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

export async function listInventoryAlerts({
  tenantId = null,
  itemSku = null,
  category = null,
  ward = null,
  alertCategory = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSku = itemSku ? cleanText(itemSku) : null;
  const normalizedCategory = category ? cleanText(category) : null;
  const normalizedWard = ward ? cleanText(ward) : null;
  const normalizedAlertCategory = alertCategory
    && ALERT_CATEGORIES.has(cleanText(alertCategory).toLowerCase())
    ? cleanText(alertCategory).toLowerCase()
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
      `SELECT a.id, a.tenant_id, a.item_sku, a.item_name, a.category, a.ward,
              a.generation_id, a.current_stock, a.reorder_point, a.max_stock,
              a.avg_daily_usage, a.baseline_daily_usage, a.days_on_hand,
              a.next_expiry_date, a.days_to_expiry, a.alert_category, a.severity,
              a.signals, a.summary, a.recommended_actions, a.source_citations,
              a.safety_flags, a.reviewer_decision, a.reviewed_by, a.reviewed_at,
              a.reviewer_note, a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_inventory_alerts a
       WHERE a.tenant_id = $1::uuid
         AND ($2::text IS NULL OR a.item_sku = $2)
         AND ($3::text IS NULL OR a.category = $3)
         AND ($4::text IS NULL OR a.ward = $4)
         AND ($5::text IS NULL OR a.alert_category = $5)
         AND ($6::text IS NULL OR a.severity = $6)
         AND ($7::text IS NULL OR a.reviewer_decision = $7)
       ORDER BY
         CASE a.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $8`,
      tid,
      normalizedSku,
      normalizedCategory,
      normalizedWard,
      normalizedAlertCategory,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeAlertRow);
    return { alerts: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { alerts: [], count: 0 };
    throw err;
  }
}

export async function decideInventoryAlert({
  tenantId = null,
  alertId,
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
    `UPDATE clinical_ai_inventory_alerts
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, item_sku, item_name, category, ward, generation_id,
               current_stock, reorder_point, max_stock, avg_daily_usage,
               baseline_daily_usage, days_on_hand, next_expiry_date, days_to_expiry,
               alert_category, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(alertId, 'alert_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Inventory alert not found');
  return normalizeAlertRow(rows[0]);
}

export default {
  ALERT_CATEGORIES,
  SEVERITIES,
  SEVERITY_PRIORITY,
  CATEGORY_PRIORITY,
  computeDaysOnHand,
  computeDaysToExpiry,
  computeConsumptionDeviationPct,
  classifyStockBand,
  classifyDaysOnHandBand,
  classifyExpiryBand,
  classifyConsumptionAnomaly,
  classifyInventoryAlert,
  escalateSeverity,
  escalateCategory,
  buildInventoryActions,
  summarizeInventory,
  evaluateInventoryItem,
  listInventoryAlerts,
  decideInventoryAlert,
};
