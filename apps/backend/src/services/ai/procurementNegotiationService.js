/**
 * Procurement Negotiation Assistant.
 *
 * Decision-support for hospital procurement/materials teams. Given a line
 * item (SKU, vendor, current unit price, historical baseline, quoted
 * alternatives, annual volume, vendor count for the category, contract
 * tenure, contract end date) classifies the negotiation opportunity as
 * price_anomaly / volume_consolidation / tenure_leverage /
 * alternatives_available / expiring_contract / no_action and estimates the
 * annual savings potential.
 *
 * Rules are authoritative. Review-only: the procurement lead negotiates.
 * The module never contacts vendors, never places or cancels orders, and
 * never modifies contracts.
 *
 * Distinct from the inventory intelligence module (non-pharmacy stock
 * levels): this service handles the buy-side procurement decision.
 *
 * Graceful degradation: if the procurement-opportunities schema is
 * missing, the service returns a schema_unavailable payload rather than
 * crashing.
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

const MODULE_KEY = 'procurement_negotiation_assistant';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support hospital procurement-lead review of line items. Rules are authoritative. Return JSON only. Never contact vendors, never place or cancel purchase orders, never modify contracts — this is decision support only and the procurement lead negotiates every action.',
  user_prompt_template:
    'Given the procurement item context and the rule-based classification, return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not override opportunity_category or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const OPPORTUNITY_CATEGORIES = new Set([
  'price_anomaly',
  'volume_consolidation',
  'tenure_leverage',
  'alternatives_available',
  'expiring_contract',
  'no_action',
  'unknown',
]);

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

// Priority: higher index = higher priority (escalate towards it).
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
export const CATEGORY_PRIORITY = [
  'unknown',
  'no_action',
  'tenure_leverage',
  'volume_consolidation',
  'alternatives_available',
  'price_anomaly',
  'expiring_contract',
];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Procurement lead review required — decision support only; the module never contacts vendors, places orders, or modifies contracts.';

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
 * Signed percentage delta of current unit price vs historical baseline.
 *   - baseline <= 0 → 0
 *   - otherwise: ((current - baseline) / baseline) * 100, clamped to
 *     -500..+500, rounded to 2 decimals.
 */
export function computePriceDeltaPct({ currentUnitPrice, historicalAvgPrice } = {}) {
  const current = toNumber(currentUnitPrice, 0);
  const baseline = toNumber(historicalAvgPrice, 0);
  if (baseline <= 0) return 0;
  const pct = ((current - baseline) / baseline) * 100;
  const clamped = Math.max(-500, Math.min(500, pct));
  return round2(clamped);
}

/**
 * Percentage savings if the quoted alternative price were taken over the
 * current unit price. Null / missing alternative → 0. Clamped 0..100.
 */
export function computeAlternativeSavingsPct({ currentUnitPrice, quotedAlternativePrice } = {}) {
  const current = toNumber(currentUnitPrice, 0);
  if (quotedAlternativePrice === null || quotedAlternativePrice === undefined || quotedAlternativePrice === '') {
    return 0;
  }
  const alt = toNumber(quotedAlternativePrice, null);
  if (alt === null || current <= 0) return 0;
  const pct = ((current - alt) / current) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  return round2(clamped);
}

/**
 * Estimated annual savings if the alternative were adopted over the current
 * unit price at the given annual volume. Missing alternative → 0.
 */
export function computeAnnualSavings({ currentUnitPrice, quotedAlternativePrice, annualVolume } = {}) {
  if (quotedAlternativePrice === null || quotedAlternativePrice === undefined || quotedAlternativePrice === '') {
    return 0;
  }
  const current = toNumber(currentUnitPrice, 0);
  const alt = toNumber(quotedAlternativePrice, null);
  const volume = toNumber(annualVolume, 0);
  if (alt === null) return 0;
  const savings = Math.max(0, (current - alt) * volume);
  return round2(savings);
}

/**
 * UTC-day diff from `today` to `contractEndDate`.
 *   - null / missing → null
 *   - past date → negative integer
 *   - otherwise → integer number of whole UTC days
 */
export function computeDaysToContractEnd({ contractEndDate, today = null } = {}) {
  if (contractEndDate === null || contractEndDate === undefined) return null;
  const endDate = toDateOnly(contractEndDate);
  if (!endDate) return null;
  const todayDate = today ? toDateOnly(today) : new Date();
  if (!todayDate) return null;
  const endUtc = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate()
  );
  const todayUtc = Date.UTC(
    todayDate.getUTCFullYear(),
    todayDate.getUTCMonth(),
    todayDate.getUTCDate()
  );
  const diffMs = endUtc - todayUtc;
  return Math.trunc(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Price band classifier:
 *   priceDeltaPct < -5       → 'discount'
 *   -5 <= priceDeltaPct < 5  → 'match'
 *   5 <= priceDeltaPct < 15  → 'above'
 *   15 <= priceDeltaPct < 30 → 'anomaly'
 *   priceDeltaPct >= 30      → 'severe_anomaly'
 */
export function classifyPriceBand(priceDeltaPct) {
  const pct = toNumber(priceDeltaPct, 0);
  if (pct < -5) return 'discount';
  if (pct < 5) return 'match';
  if (pct < 15) return 'above';
  if (pct < 30) return 'anomaly';
  return 'severe_anomaly';
}

/**
 * Vendor fragmentation classifier:
 *   count === 1 → 'single'
 *   count 2-3   → 'dual'
 *   count 4-6   → 'fragmented'
 *   count >= 7  → 'excessive'
 */
export function classifyVendorFragmentation({ vendorCountForCategory } = {}) {
  const count = toNumber(vendorCountForCategory, 1);
  if (count <= 1) return 'single';
  if (count <= 3) return 'dual';
  if (count <= 6) return 'fragmented';
  return 'excessive';
}

/**
 * Contract tenure band classifier:
 *   null → 'unknown'
 *   < 12  → 'new'
 *   12-35 → 'mature'
 *   36-59 → 'long'
 *   >= 60 → 'legacy'
 */
export function classifyTenureBand(tenureMonths) {
  if (tenureMonths === null || tenureMonths === undefined) return 'unknown';
  const months = toNumber(tenureMonths, null);
  if (months === null || !Number.isFinite(months)) return 'unknown';
  if (months < 12) return 'new';
  if (months < 36) return 'mature';
  if (months < 60) return 'long';
  return 'legacy';
}

/**
 * Contract expiry band classifier:
 *   null → 'unknown'
 *   < 0   → 'expired'
 *   <= 30 → 'imminent'
 *   <= 90 → 'warning'
 *   <= 180 → 'watch'
 *   > 180  → 'ok'
 */
export function classifyExpiryBand(daysToContractEnd) {
  if (daysToContractEnd === null || daysToContractEnd === undefined) return 'unknown';
  const days = toNumber(daysToContractEnd, null);
  if (days === null || !Number.isFinite(days)) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= 30) return 'imminent';
  if (days <= 90) return 'warning';
  if (days <= 180) return 'watch';
  return 'ok';
}

/**
 * Alternative-savings band classifier:
 *   < 5  → 'none'
 *   < 15 → 'modest'
 *   < 25 → 'meaningful'
 *   >= 25 → 'strong'
 */
export function classifyAlternativeBand(alternativeSavingsPct) {
  const pct = toNumber(alternativeSavingsPct, 0);
  if (pct < 5) return 'none';
  if (pct < 15) return 'modest';
  if (pct < 25) return 'meaningful';
  return 'strong';
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
    const normalized = OPPORTUNITY_CATEGORIES.has(cat) ? cat : 'unknown';
    const idx = CATEGORY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Classify a procurement record into an opportunity_category + severity +
 * signal list.
 *
 * Accepts raw metrics (currentUnitPrice, historicalAvgPrice,
 * quotedAlternativePrice, annualVolume, vendorCountForCategory,
 * contractTenureMonths, contractEndDate, today) and optional precomputed
 * bands.
 *
 * Rules are applied in priority order: each matched rule emits a candidate
 * (category, severity, signal). The winning category is the one with the
 * highest CATEGORY_PRIORITY index; severity is the highest seen across all
 * matched rules. Signals from ALL matched rules are aggregated so the
 * reviewer sees the full picture.
 *
 * Returns { opportunity_category, severity, signals: [{ code, detail? }] }.
 */
export function classifyProcurementOpportunity(metrics = {}) {
  const {
    currentUnitPrice = 0,
    historicalAvgPrice = 0,
    quotedAlternativePrice = null,
    annualVolume = 0,
    vendorCountForCategory = 1,
    contractTenureMonths = null,
    contractEndDate = null,
    today = null,
  } = metrics;

  const priceDeltaPct = metrics.priceDeltaPct !== undefined
    ? toNumber(metrics.priceDeltaPct, 0)
    : computePriceDeltaPct({ currentUnitPrice, historicalAvgPrice });
  const alternativeSavingsPct = metrics.alternativeSavingsPct !== undefined
    ? toNumber(metrics.alternativeSavingsPct, 0)
    : computeAlternativeSavingsPct({ currentUnitPrice, quotedAlternativePrice });
  const daysToContractEnd = metrics.daysToContractEnd !== undefined
    ? metrics.daysToContractEnd
    : computeDaysToContractEnd({ contractEndDate, today });

  const priceBand = metrics.priceBand || classifyPriceBand(priceDeltaPct);
  const vendorFragmentation = metrics.vendorFragmentation
    || classifyVendorFragmentation({ vendorCountForCategory });
  const tenureBand = metrics.tenureBand || classifyTenureBand(contractTenureMonths);
  const expiryBand = metrics.expiryBand || classifyExpiryBand(daysToContractEnd);
  const alternativeBand = metrics.alternativeBand || classifyAlternativeBand(alternativeSavingsPct);

  const categoryCandidates = [];
  const severityCandidates = [];
  const signals = [];

  const pushSignal = (code, detail) => {
    signals.push(detail ? { code, detail } : { code });
  };

  // expiryBand === 'imminent' → expiring_contract / high
  if (expiryBand === 'imminent') {
    categoryCandidates.push('expiring_contract');
    severityCandidates.push('high');
    pushSignal('EXPIRING_CONTRACT', 'Contract end within 30 days; window for renegotiation is closing.');
  }

  // expiryBand === 'expired' → expiring_contract / critical
  if (expiryBand === 'expired') {
    categoryCandidates.push('expiring_contract');
    severityCandidates.push('critical');
    pushSignal('EXPIRING_CONTRACT', 'Contract has already lapsed; renegotiate or formally close out.');
  }

  // priceBand === 'severe_anomaly' → price_anomaly / high
  // (Severe deviations trigger a PRICE_SEVERE_ANOMALY signal; 'critical' is
  // reserved for expired contracts, which always require immediate action.)
  if (priceBand === 'severe_anomaly') {
    categoryCandidates.push('price_anomaly');
    severityCandidates.push('high');
    pushSignal('PRICE_SEVERE_ANOMALY', 'Current unit price is >= 30% above historical baseline.');
  }

  // priceBand === 'anomaly' → price_anomaly / high
  if (priceBand === 'anomaly') {
    categoryCandidates.push('price_anomaly');
    severityCandidates.push('high');
    pushSignal('PRICE_ANOMALY', 'Current unit price is 15-30% above historical baseline.');
  }

  // alternativeBand === 'strong' → alternatives_available / high
  if (alternativeBand === 'strong') {
    categoryCandidates.push('alternatives_available');
    severityCandidates.push('high');
    pushSignal('STRONG_ALTERNATIVE', 'Quoted alternative would save >= 25% vs current unit price.');
  }

  // alternativeBand === 'meaningful' → alternatives_available / moderate
  if (alternativeBand === 'meaningful') {
    categoryCandidates.push('alternatives_available');
    severityCandidates.push('moderate');
    pushSignal('MEANINGFUL_ALTERNATIVE', 'Quoted alternative would save 15-25% vs current unit price.');
  }

  // vendorFragmentation 'fragmented' + annualVolume >= 100000 → volume_consolidation / moderate
  if (vendorFragmentation === 'fragmented' && toNumber(annualVolume, 0) >= 100000) {
    categoryCandidates.push('volume_consolidation');
    severityCandidates.push('moderate');
    pushSignal(
      'CONSOLIDATION_OPPORTUNITY',
      'Category spend split across 4-6 vendors with annual volume >= 100k; consolidating may unlock volume pricing.'
    );
  }

  // vendorFragmentation 'excessive' + annualVolume >= 100000 → volume_consolidation / high
  if (vendorFragmentation === 'excessive' && toNumber(annualVolume, 0) >= 100000) {
    categoryCandidates.push('volume_consolidation');
    severityCandidates.push('high');
    pushSignal(
      'CONSOLIDATION_OPPORTUNITY',
      'Category spend split across 7+ vendors with annual volume >= 100k; excessive fragmentation.'
    );
  }

  // tenureBand in ('long','legacy') AND priceBand !== 'discount' AND expiryBand NOT in ('imminent','expired')
  // → tenure_leverage / moderate
  if (
    (tenureBand === 'long' || tenureBand === 'legacy')
    && priceBand !== 'discount'
    && expiryBand !== 'imminent'
    && expiryBand !== 'expired'
  ) {
    categoryCandidates.push('tenure_leverage');
    severityCandidates.push('moderate');
    pushSignal(
      'LONG_TENURE',
      'Contract tenure >= 36 months without a price review; leverage incumbency for better terms.'
    );
  }

  // Default: no_action.
  if (!categoryCandidates.length) {
    categoryCandidates.push('no_action');
    severityCandidates.push('low');
    pushSignal('HEALTHY_DEAL', 'Current deal is favourable; no immediate negotiation action required.');
  }

  const final_category = escalateCategory(categoryCandidates);
  const final_severity = escalateSeverity(severityCandidates);

  const opportunity_category = OPPORTUNITY_CATEGORIES.has(final_category) ? final_category : 'unknown';
  const severity = SEVERITIES.has(final_severity) ? final_severity : 'unknown';

  return {
    opportunity_category,
    severity,
    signals,
  };
}

/**
 * Build reviewer-facing negotiation actions for the opportunity. At least
 * one action mentions the item name or vendor name if provided. Always
 * ends with the procurement-lead disclaimer.
 */
export function buildProcurementActions({
  opportunityCategory,
  signals = [],
  vendorName = null,
  itemName = null,
} = {}) {
  const item = cleanText(itemName);
  const vendor = cleanText(vendorName);
  const namePhrase = item || vendor || 'this line item';
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (opportunityCategory) {
    case 'price_anomaly':
      push(`Challenge the current unit price for ${namePhrase} against the historical baseline and recent market quotes.`);
      if (vendor) {
        push(`Request a written price justification from ${vendor} and ask for a rollback to the historical band.`);
      } else {
        push('Request a written price justification from the current vendor and ask for a rollback to the historical band.');
      }
      push('Prepare a walk-away benchmark from comparable vendors before the next procurement call.');
      break;
    case 'alternatives_available':
      push(`Share the lower alternative quote with ${vendor || 'the incumbent vendor'} for ${namePhrase} and ask them to match or beat it.`);
      push('Validate that the alternative meets the same clinical/operational specification before switching.');
      break;
    case 'volume_consolidation':
      push(`Consolidate category spend covering ${namePhrase} to 1-2 preferred vendors to unlock volume tiers.`);
      push('Benchmark a rate card based on consolidated annual volume with the top candidates.');
      break;
    case 'tenure_leverage':
      if (vendor) {
        push(`Use long-tenure incumbency with ${vendor} as leverage to request a structured price review for ${namePhrase}.`);
      } else {
        push(`Use long-tenure incumbency as leverage to request a structured price review for ${namePhrase}.`);
      }
      push('Introduce a clause for annual price review at the next contract cycle.');
      break;
    case 'expiring_contract':
      push(`Start renewal negotiations for ${namePhrase} with a target effective date before the current contract ends.`);
      push('Issue an RFQ to 2-3 additional vendors in parallel to establish a competitive benchmark.');
      break;
    case 'no_action':
    default:
      push(`${namePhrase} is within the healthy operating range; continue routine monitoring and re-benchmark annually.`);
      break;
  }

  // Map matched signal codes to supplementary actions.
  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'PRICE_SEVERE_ANOMALY') {
      push('Escalate to the procurement lead immediately — current price deviation is severe.');
    } else if (code === 'STRONG_ALTERNATIVE') {
      push('Do not sign the next purchase order until the alternative has been assessed.');
    } else if (code === 'EXPIRING_CONTRACT') {
      push('Add the renewal to this week\u2019s procurement review agenda.');
    } else if (code === 'CONSOLIDATION_OPPORTUNITY') {
      push('Model the consolidated-volume savings vs the current multi-vendor mix.');
    } else if (code === 'LONG_TENURE') {
      push('Audit the last three purchase orders to quantify cumulative price drift.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary for the opportunity row.
 */
export function summarizeProcurement({
  itemName,
  vendorName,
  opportunityCategory,
  severity,
  priceDeltaPct,
  annualSavings,
} = {}) {
  const item = cleanText(itemName) || 'line item';
  const vendor = cleanText(vendorName);
  const cat = OPPORTUNITY_CATEGORIES.has(opportunityCategory) ? opportunityCategory : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const deltaText = `price delta ${toNumber(priceDeltaPct, 0)}%`;
  const savingsText = `estimated annual savings ${toNumber(annualSavings, 0)}`;
  const vendorText = vendor ? ` from ${vendor}` : '';
  return `${item}${vendorText}: ${cat} (${sev}), ${deltaText}, ${savingsText}.`;
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
      logger.warn('Procurement negotiation generation persist failed', { error: err.message });
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'PROCUREMENT_LEAD', 'MATERIALS_MANAGER'],
        source: 'procurement_negotiation_assistant',
        item_sku: itemSku || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Procurement negotiation review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeOpportunityRow(row) {
  if (!row) return row;
  return {
    ...row,
    current_unit_price: row.current_unit_price !== null && row.current_unit_price !== undefined
      ? toNumber(row.current_unit_price, 0)
      : 0,
    historical_avg_price: row.historical_avg_price !== null && row.historical_avg_price !== undefined
      ? toNumber(row.historical_avg_price, 0)
      : 0,
    historical_min_price: row.historical_min_price !== null && row.historical_min_price !== undefined
      ? toNumber(row.historical_min_price, null)
      : null,
    quoted_alternative_price: row.quoted_alternative_price !== null && row.quoted_alternative_price !== undefined
      ? toNumber(row.quoted_alternative_price, null)
      : null,
    annual_volume: row.annual_volume !== null && row.annual_volume !== undefined
      ? toNumber(row.annual_volume, 0)
      : 0,
    vendor_count_for_category: row.vendor_count_for_category !== null && row.vendor_count_for_category !== undefined
      ? toNumber(row.vendor_count_for_category, 1)
      : 1,
    contract_tenure_months: row.contract_tenure_months !== null && row.contract_tenure_months !== undefined
      ? toNumber(row.contract_tenure_months, null)
      : null,
    price_delta_pct: row.price_delta_pct !== null && row.price_delta_pct !== undefined
      ? toNumber(row.price_delta_pct, 0)
      : 0,
    alternative_savings_pct: row.alternative_savings_pct !== null && row.alternative_savings_pct !== undefined
      ? toNumber(row.alternative_savings_pct, 0)
      : 0,
    estimated_annual_savings: row.estimated_annual_savings !== null && row.estimated_annual_savings !== undefined
      ? toNumber(row.estimated_annual_savings, 0)
      : 0,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertOpportunityRow({
  tenantId,
  itemSku,
  itemName,
  category,
  vendorName,
  generationId,
  currentUnitPrice,
  historicalAvgPrice,
  historicalMinPrice,
  quotedAlternativePrice,
  annualVolume,
  vendorCountForCategory,
  contractTenureMonths,
  contractEndDate,
  priceDeltaPct,
  alternativeSavingsPct,
  estimatedAnnualSavings,
  opportunityCategory,
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
      `INSERT INTO clinical_ai_procurement_opportunities
         (tenant_id, item_sku, item_name, category, vendor_name, generation_id,
          current_unit_price, historical_avg_price, historical_min_price,
          quoted_alternative_price, annual_volume, vendor_count_for_category,
          contract_tenure_months, contract_end_date, price_delta_pct,
          alternative_savings_pct, estimated_annual_savings,
          opportunity_category, severity, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6,
               $7, $8, $9,
               $10, $11, $12,
               $13, $14::date, $15,
               $16, $17,
               $18, $19, $20::jsonb, $21, $22::jsonb,
               $23::jsonb, $24::jsonb, 'pending', $25::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, item_sku, item_name, category, vendor_name,
                 generation_id, current_unit_price, historical_avg_price,
                 historical_min_price, quoted_alternative_price, annual_volume,
                 vendor_count_for_category, contract_tenure_months, contract_end_date,
                 price_delta_pct, alternative_savings_pct, estimated_annual_savings,
                 opportunity_category, severity, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      itemSku,
      itemName,
      category,
      vendorName,
      generationId,
      currentUnitPrice,
      historicalAvgPrice,
      historicalMinPrice,
      quotedAlternativePrice,
      annualVolume,
      vendorCountForCategory,
      contractTenureMonths,
      contractEndDate,
      priceDeltaPct,
      alternativeSavingsPct,
      estimatedAnnualSavings,
      OPPORTUNITY_CATEGORIES.has(opportunityCategory) ? opportunityCategory : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      JSON.stringify(asArray(signals)),
      summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(sourceCitations)),
      JSON.stringify(asArray(safetyFlags)),
      JSON.stringify(metadata || {})
    );
    return normalizeOpportunityRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateProcurementOpportunity({
  req = null,
  itemSku,
  itemName,
  category = null,
  vendorName = null,
  currentUnitPrice,
  historicalAvgPrice = 0,
  historicalMinPrice = null,
  quotedAlternativePrice = null,
  annualVolume = 0,
  vendorCountForCategory = 1,
  contractTenureMonths = null,
  contractEndDate = null,
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
  if (currentUnitPrice === null || currentUnitPrice === undefined || currentUnitPrice === '') {
    throw AppError.badRequest('current_unit_price is required');
  }
  const current = Number(currentUnitPrice);
  if (!Number.isFinite(current)) {
    throw AppError.badRequest('current_unit_price must be a finite number');
  }

  const historicalAvg = toNumber(historicalAvgPrice, 0);
  const historicalMin = toNullableNumber(historicalMinPrice);
  const quotedAlt = toNullableNumber(quotedAlternativePrice);
  const volume = toNumber(annualVolume, 0);
  const vendorCount = toNumber(vendorCountForCategory, 1);
  const tenureMonths = toNullableNumber(contractTenureMonths);
  const safeCategory = category ? cleanText(category) : null;
  const safeVendor = vendorName ? cleanText(vendorName) : null;
  const endDateIso = contractEndDate ? (() => {
    const d = toDateOnly(contractEndDate);
    return d ? d.toISOString().slice(0, 10) : null;
  })() : null;

  // Compute metrics.
  const priceDeltaPct = computePriceDeltaPct({
    currentUnitPrice: current,
    historicalAvgPrice: historicalAvg,
  });
  const alternativeSavingsPct = computeAlternativeSavingsPct({
    currentUnitPrice: current,
    quotedAlternativePrice: quotedAlt,
  });
  const estimatedAnnualSavings = computeAnnualSavings({
    currentUnitPrice: current,
    quotedAlternativePrice: quotedAlt,
    annualVolume: volume,
  });
  const daysToContractEnd = computeDaysToContractEnd({
    contractEndDate: endDateIso,
    today,
  });

  // Classify.
  const classification = classifyProcurementOpportunity({
    currentUnitPrice: current,
    historicalAvgPrice: historicalAvg,
    quotedAlternativePrice: quotedAlt,
    annualVolume: volume,
    vendorCountForCategory: vendorCount,
    contractTenureMonths: tenureMonths,
    contractEndDate: endDateIso,
    today,
    priceDeltaPct,
    alternativeSavingsPct,
    daysToContractEnd,
  });

  const recommendedActions = buildProcurementActions({
    opportunityCategory: classification.opportunity_category,
    signals: classification.signals,
    vendorName: safeVendor,
    itemName: name,
  });

  const summary = summarizeProcurement({
    itemName: name,
    vendorName: safeVendor,
    opportunityCategory: classification.opportunity_category,
    severity: classification.severity,
    priceDeltaPct,
    annualSavings: estimatedAnnualSavings,
  });

  // Citations.
  const citations = [
    {
      source_type: 'procurement_record',
      source_id: sku,
      label: `Procurement — ${name} (${sku})`,
      timestamp: null,
    },
    {
      source_type: 'item',
      source_id: sku,
      label: `Item ${name}`,
      timestamp: null,
    },
  ];
  if (safeVendor) {
    citations.push({
      source_type: 'vendor',
      source_id: safeVendor,
      label: `Vendor — ${safeVendor}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'procurement_rules',
    source_id: MODULE_KEY,
    label: 'Procurement negotiation rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (classification.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'PROCUREMENT_CRITICAL',
      message: 'Critical procurement opportunity — notify the procurement lead immediately.',
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Procurement opportunity has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'PROCUREMENT_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — the procurement lead negotiates every action; the module never contacts vendors, places orders, or modifies contracts.',
  });

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    item_sku: sku,
    item_name: name,
    category: safeCategory,
    vendor_name: safeVendor,
    inputs: {
      current_unit_price: current,
      historical_avg_price: historicalAvg,
      historical_min_price: historicalMin,
      quoted_alternative_price: quotedAlt,
      annual_volume: volume,
      vendor_count_for_category: vendorCount,
      contract_tenure_months: tenureMonths,
      contract_end_date: endDateIso,
    },
    metrics: {
      price_delta_pct: priceDeltaPct,
      alternative_savings_pct: alternativeSavingsPct,
      estimated_annual_savings: estimatedAnnualSavings,
      days_to_contract_end: daysToContractEnd,
    },
    opportunity_category: classification.opportunity_category,
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
        item: {
          item_sku: sku,
          item_name: name,
          category: safeCategory,
          vendor_name: safeVendor,
        },
        inputs: fallbackDraft.inputs,
        metrics: fallbackDraft.metrics,
        rule_based_evaluation: {
          opportunity_category: classification.opportunity_category,
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
    logger.debug('Procurement negotiation AI narrative unavailable; using template fallback', {
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
        item: { sku, name, category: safeCategory, vendor: safeVendor },
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
      vendor_name: safeVendor,
      category: safeCategory,
      inputs: fallbackDraft.inputs,
      opportunity_category: classification.opportunity_category,
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
      vendor_name: safeVendor,
      opportunity_category: classification.opportunity_category,
      severity: classification.severity,
      signal_codes: classification.signals.map((s) => s.code),
      price_delta_pct: priceDeltaPct,
      alternative_savings_pct: alternativeSavingsPct,
      estimated_annual_savings: estimatedAnnualSavings,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist opportunity row.
  const opportunityRow = await insertOpportunityRow({
    tenantId,
    itemSku: sku,
    itemName: name,
    category: safeCategory,
    vendorName: safeVendor,
    generationId: generation?.id || null,
    currentUnitPrice: current,
    historicalAvgPrice: historicalAvg,
    historicalMinPrice: historicalMin,
    quotedAlternativePrice: quotedAlt,
    annualVolume: volume,
    vendorCountForCategory: vendorCount,
    contractTenureMonths: tenureMonths,
    contractEndDate: endDateIso,
    priceDeltaPct,
    alternativeSavingsPct,
    estimatedAnnualSavings,
    opportunityCategory: classification.opportunity_category,
    severity: classification.severity,
    signals: classification.signals,
    summary: draft.summary,
    recommendedActions,
    sourceCitations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      days_to_contract_end: daysToContractEnd,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!opportunityRow) {
    return {
      opportunity_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      opportunity_category: classification.opportunity_category,
      severity: classification.severity,
      signals: classification.signals,
      price_delta_pct: priceDeltaPct,
      alternative_savings_pct: alternativeSavingsPct,
      estimated_annual_savings: estimatedAnnualSavings,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_procurement_opportunities_unavailable',
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
      eventType: 'clinical_ai.procurement_opportunity_generated',
      aggregateType: 'clinical_ai_procurement_opportunity',
      aggregateId: opportunityRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        opportunity_id: opportunityRow.id,
        generation_id: generation?.id || null,
        item_sku: sku,
        item_name: name,
        category: safeCategory,
        vendor_name: safeVendor,
        opportunity_category: classification.opportunity_category,
        severity: classification.severity,
        signal_codes: classification.signals.map((s) => s.code),
        price_delta_pct: priceDeltaPct,
        alternative_savings_pct: alternativeSavingsPct,
        estimated_annual_savings: estimatedAnnualSavings,
      },
    });
  } catch (err) {
    logger.warn('Procurement negotiation event publish failed', { error: err?.message });
  }

  return {
    opportunity_id: opportunityRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    opportunity: opportunityRow,
    opportunity_category: classification.opportunity_category,
    severity: classification.severity,
    signals: classification.signals,
    price_delta_pct: priceDeltaPct,
    alternative_savings_pct: alternativeSavingsPct,
    estimated_annual_savings: estimatedAnnualSavings,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || opportunityRow.reviewer_decision || 'pending',
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

export async function listProcurementOpportunities({
  tenantId = null,
  itemSku = null,
  category = null,
  vendorName = null,
  opportunityCategory = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSku = itemSku ? cleanText(itemSku) : null;
  const normalizedCategory = category ? cleanText(category) : null;
  const normalizedVendor = vendorName ? cleanText(vendorName) : null;
  const normalizedOpportunityCategory = opportunityCategory
    && OPPORTUNITY_CATEGORIES.has(cleanText(opportunityCategory).toLowerCase())
    ? cleanText(opportunityCategory).toLowerCase()
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
      `SELECT o.id, o.tenant_id, o.item_sku, o.item_name, o.category, o.vendor_name,
              o.generation_id, o.current_unit_price, o.historical_avg_price,
              o.historical_min_price, o.quoted_alternative_price, o.annual_volume,
              o.vendor_count_for_category, o.contract_tenure_months, o.contract_end_date,
              o.price_delta_pct, o.alternative_savings_pct, o.estimated_annual_savings,
              o.opportunity_category, o.severity, o.signals, o.summary,
              o.recommended_actions, o.source_citations, o.safety_flags,
              o.reviewer_decision, o.reviewed_by, o.reviewed_at, o.reviewer_note,
              o.metadata, o.created_at, o.updated_at
       FROM clinical_ai_procurement_opportunities o
       WHERE o.tenant_id = $1::uuid
         AND ($2::text IS NULL OR o.item_sku = $2)
         AND ($3::text IS NULL OR o.category = $3)
         AND ($4::text IS NULL OR o.vendor_name = $4)
         AND ($5::text IS NULL OR o.opportunity_category = $5)
         AND ($6::text IS NULL OR o.severity = $6)
         AND ($7::text IS NULL OR o.reviewer_decision = $7)
       ORDER BY
         CASE o.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         o.created_at DESC
       LIMIT $8`,
      tid,
      normalizedSku,
      normalizedCategory,
      normalizedVendor,
      normalizedOpportunityCategory,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeOpportunityRow);
    return { opportunities: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { opportunities: [], count: 0 };
    throw err;
  }
}

export async function decideProcurementOpportunity({
  tenantId = null,
  opportunityId,
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
    `UPDATE clinical_ai_procurement_opportunities
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, item_sku, item_name, category, vendor_name, generation_id,
               current_unit_price, historical_avg_price, historical_min_price,
               quoted_alternative_price, annual_volume, vendor_count_for_category,
               contract_tenure_months, contract_end_date, price_delta_pct,
               alternative_savings_pct, estimated_annual_savings,
               opportunity_category, severity, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(opportunityId, 'opportunity_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Procurement opportunity not found');
  return normalizeOpportunityRow(rows[0]);
}

export default {
  OPPORTUNITY_CATEGORIES,
  SEVERITIES,
  SEVERITY_PRIORITY,
  CATEGORY_PRIORITY,
  computePriceDeltaPct,
  computeAlternativeSavingsPct,
  computeAnnualSavings,
  computeDaysToContractEnd,
  classifyPriceBand,
  classifyVendorFragmentation,
  classifyTenureBand,
  classifyExpiryBand,
  classifyAlternativeBand,
  classifyProcurementOpportunity,
  escalateSeverity,
  escalateCategory,
  buildProcurementActions,
  summarizeProcurement,
  evaluateProcurementOpportunity,
  listProcurementOpportunities,
  decideProcurementOpportunity,
};
