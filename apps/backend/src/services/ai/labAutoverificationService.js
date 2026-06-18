/**
 * Lab Autoverification / Delta Check Assistant.
 *
 * Evaluates each lab result against reference ranges, critical thresholds,
 * and the patient's prior value for the same test. Emits an auto_verify /
 * hold_for_review / critical / rejected decision plus suggested actions.
 * Rules are authoritative — the AI layer may add a short narrative summary
 * but this service never auto-releases, corrects, or repeats a lab result.
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

const MODULE_KEY = 'lab_autoverification_delta';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support lab autoverification review. Rules are authoritative. Use only the supplied lab result, reference range, critical thresholds, and prior value. Return JSON only.',
  user_prompt_template: 'Summarize the lab autoverification rationale. Do not auto-release, correct, or repeat results.',
};

const CRITICAL_BANDS = new Set(['normal', 'borderline_low', 'borderline_high', 'critical_low', 'critical_high', 'unknown']);
const DECISIONS = new Set(['auto_verify', 'hold_for_review', 'critical', 'rejected', 'pending']);
const REVIEWER_DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_REVIEWER_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const LARGE_DELTA_PCT = 50;
const AUTO_VERIFY_DELTA_PCT = 20;

// Reference ranges and critical thresholds, keyed by normalized test_name
// substring. Deliberately small — site-specific ranges belong in a registry
// once one exists; until then these conservative adult ranges let the rules
// classify the most common panels so the reviewer has a starting point.
const TEST_RANGES = [
  { match: ['potassium', 'k+', 'serum k'], units: 'mmol/L', referenceLow: 3.5, referenceHigh: 5.0, criticalLow: 2.5, criticalHigh: 6.5 },
  { match: ['sodium', 'na+', 'serum na'], units: 'mmol/L', referenceLow: 135, referenceHigh: 145, criticalLow: 120, criticalHigh: 160 },
  { match: ['glucose', 'blood sugar', 'rbs', 'fbs'], units: 'mg/dL', referenceLow: 70, referenceHigh: 200, criticalLow: 40, criticalHigh: 500 },
  { match: ['creatinine'], units: 'mg/dL', referenceLow: 0.6, referenceHigh: 1.3, criticalLow: null, criticalHigh: 10 },
  { match: ['hemoglobin', 'haemoglobin', 'hb', 'hgb'], units: 'g/dL', referenceLow: 13, referenceHigh: 17, criticalLow: 6, criticalHigh: null },
  { match: ['platelet', 'platelets', 'plt'], units: 'x10^3/uL', referenceLow: 150, referenceHigh: 400, criticalLow: 50, criticalHigh: 1000 },
  { match: ['wbc', 'white blood cell', 'total leukocyte', 'tlc'], units: 'x10^3/uL', referenceLow: 4, referenceHigh: 11, criticalLow: 1, criticalHigh: 50 },
  { match: ['calcium'], units: 'mg/dL', referenceLow: 8.5, referenceHigh: 10.5, criticalLow: 6, criticalHigh: 13 },
  { match: ['magnesium'], units: 'mg/dL', referenceLow: 1.7, referenceHigh: 2.2, criticalLow: 1, criticalHigh: 4 },
  { match: ['inr'], units: 'ratio', referenceLow: 0.8, referenceHigh: 1.1, criticalLow: null, criticalHigh: 5 },
  { match: ['troponin'], units: 'ng/mL', referenceLow: null, referenceHigh: 0.04, criticalLow: null, criticalHigh: 0.5 },
  { match: ['lactate'], units: 'mmol/L', referenceLow: 0.5, referenceHigh: 2.0, criticalLow: null, criticalHigh: 4 },
];

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

function normalizedText(value) {
  return cleanText(value).toLowerCase();
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function round2(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Compute the delta between a current and prior numeric value.
 *
 * delta_pct = ((current - prior) / |prior|) * 100, rounded to 2dp.
 * Returns { delta_minor: null, delta_pct: null } when priorValue is null,
 * undefined, or 0, or when currentValue is null/undefined.
 */
export function calculateDelta({ currentValue, priorValue } = {}) {
  const current = toNumber(currentValue, null);
  const prior = toNumber(priorValue, null);
  if (current === null) return { delta_minor: null, delta_pct: null };
  if (prior === null || prior === 0) return { delta_minor: null, delta_pct: null };
  const deltaMinor = current - prior;
  const deltaPct = (deltaMinor / Math.abs(prior)) * 100;
  return {
    delta_minor: round2(deltaMinor),
    delta_pct: round2(deltaPct),
  };
}

/**
 * Classify a numeric lab value against reference and critical thresholds.
 *
 * Returns one of:
 *   'unknown'        — value is null, OR no reference range AND no critical thresholds
 *   'critical_low'   — value <= criticalLow
 *   'critical_high'  — value >= criticalHigh
 *   'borderline_low' — value < referenceLow (and not critical_low)
 *   'borderline_high'— value > referenceHigh (and not critical_high)
 *   'normal'         — otherwise
 */
export function classifyCriticalBand({
  value,
  referenceLow = null,
  referenceHigh = null,
  criticalLow = null,
  criticalHigh = null,
} = {}) {
  const v = toNumber(value, null);
  if (v === null) return 'unknown';
  const rLow = toNumber(referenceLow, null);
  const rHigh = toNumber(referenceHigh, null);
  const cLow = toNumber(criticalLow, null);
  const cHigh = toNumber(criticalHigh, null);
  const hasReference = rLow !== null || rHigh !== null;
  const hasCritical = cLow !== null || cHigh !== null;
  if (!hasReference && !hasCritical) return 'unknown';
  if (cLow !== null && v <= cLow) return 'critical_low';
  if (cHigh !== null && v >= cHigh) return 'critical_high';
  if (rLow !== null && v < rLow) return 'borderline_low';
  if (rHigh !== null && v > rHigh) return 'borderline_high';
  return 'normal';
}

/**
 * Rules-authoritative autoverification decision.
 *
 * Returns { decision, decision_reason, suggested_actions }.
 *
 * Priority order:
 *   1. critical_low / critical_high -> 'critical'
 *   2. |deltaPct| > LARGE_DELTA_PCT -> 'hold_for_review'
 *   3. borderline_low / borderline_high -> 'hold_for_review'
 *   4. hasAbnormalFlags -> 'hold_for_review'
 *   5. normal + priorValue present + |deltaPct| <= AUTO_VERIFY_DELTA_PCT -> 'auto_verify'
 *   6. priorValue null -> 'hold_for_review' (conservative)
 *   7. fallthrough -> 'hold_for_review'
 */
export function buildAutoverificationDecision({
  criticalBand,
  deltaPct = null,
  priorValue = null,
  hasAbnormalFlags = false,
} = {}) {
  const band = CRITICAL_BANDS.has(criticalBand) ? criticalBand : 'unknown';
  const delta = deltaPct === null || deltaPct === undefined ? null : toNumber(deltaPct, null);
  const absDelta = delta === null ? null : Math.abs(delta);
  const priorKnown = priorValue !== null && priorValue !== undefined;

  if (band === 'critical_low' || band === 'critical_high') {
    return {
      decision: 'critical',
      decision_reason: `Result is in the ${band.replace('_', ' ')} critical band. Do not release without clinician confirmation.`,
      suggested_actions: [
        'Notify ordering clinician immediately (telephone hand-off; document the call).',
        'Repeat or confirm the result before release; verify specimen integrity and analyzer QC.',
        'Do not auto-release — escalate to pathologist/lab-in-charge if repeat is not possible.',
      ],
    };
  }

  if (absDelta !== null && absDelta > LARGE_DELTA_PCT) {
    return {
      decision: 'hold_for_review',
      decision_reason: `Delta of ${delta}% vs prior exceeds ${LARGE_DELTA_PCT}% — large swing may indicate specimen or analytical issue.`,
      suggested_actions: [
        'Confirm specimen integrity; repeat the test if needed before release.',
        'Check analyzer QC and reagent lot since the prior result.',
        'Hold for pathologist / lab-in-charge review before release.',
      ],
    };
  }

  if (band === 'borderline_low' || band === 'borderline_high') {
    return {
      decision: 'hold_for_review',
      decision_reason: `Result is ${band.replace('_', ' ')} versus the reference range.`,
      suggested_actions: [
        'Compare against patient history and clinical context before release.',
        'Route to pathologist / lab-in-charge for sign-off.',
      ],
    };
  }

  if (hasAbnormalFlags) {
    return {
      decision: 'hold_for_review',
      decision_reason: 'Upstream analyzer / LIS flagged the result as abnormal. Holding for human review.',
      suggested_actions: [
        'Review upstream analyzer/LIS flags before release.',
        'Confirm reference range and units before accepting.',
      ],
    };
  }

  if (band === 'normal' && priorKnown && absDelta !== null && absDelta <= AUTO_VERIFY_DELTA_PCT) {
    return {
      decision: 'auto_verify',
      decision_reason: `Result is within the reference range and within ${AUTO_VERIFY_DELTA_PCT}% of the prior value — eligible for autoverification.`,
      suggested_actions: [
        'Autoverification eligible; lab staff still confirms before release per policy.',
      ],
    };
  }

  if (!priorKnown) {
    return {
      decision: 'hold_for_review',
      decision_reason: 'No prior value available for delta comparison; holding for human review (conservative default).',
      suggested_actions: [
        'Compare with patient history or prior results from outside labs before release.',
        'Route to lab staff / pathologist for sign-off.',
      ],
    };
  }

  return {
    decision: 'hold_for_review',
    decision_reason: 'Insufficient information for autoverification.',
    suggested_actions: [
      'Route to lab staff / pathologist for review before release.',
    ],
  };
}

/**
 * Look up a canned reference range + critical thresholds by test name.
 * Returns null if no known range matches.
 */
export function lookupReferenceRange(testName) {
  const name = normalizedText(testName);
  if (!name) return null;
  for (const range of TEST_RANGES) {
    if (range.match.some((term) => name.includes(term))) {
      return {
        units: range.units,
        reference_low: range.referenceLow,
        reference_high: range.referenceHigh,
        critical_low: range.criticalLow,
        critical_high: range.criticalHigh,
      };
    }
  }
  return null;
}

function parseNumericFromText(text) {
  if (text === null || text === undefined) return null;
  const str = String(text);
  const match = str.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractResultValue(row) {
  if (!row) return null;
  const candidates = [
    row.result_value,
    row.value,
    row.results?.value,
    row.results?.numeric_value,
    row.structured_results?.value,
    row.structured_results?.numeric_value,
  ];
  for (const candidate of candidates) {
    const numeric = toNumber(candidate, null);
    if (numeric !== null) return numeric;
  }
  return parseNumericFromText(row.result_summary || row.interpretation || row.conclusion || row.notes);
}

function extractUnits(row, fallback = null) {
  if (!row) return fallback;
  return (
    row.units
    || row.unit
    || row.results?.units
    || row.results?.unit
    || row.structured_results?.units
    || row.structured_results?.unit
    || fallback
  );
}

function extractAbnormalFlag(row) {
  if (!row) return false;
  const fromStructured = row.structured_results?.abnormal_flag || row.structured_results?.abnormal;
  const fromResults = row.results?.abnormal_flag || row.results?.abnormal;
  const direct = row.abnormal_flag;
  const flag = fromStructured || fromResults || direct || '';
  if (!flag) return false;
  const str = normalizedText(flag);
  return /abnormal|high|low|critical|panic|h\b|l\b|hh\b|ll\b/.test(str) && str !== 'normal';
}

async function loadInvestigation(investigationId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, patient_uid, phone, test_name, test_type, status,
              result_summary, results, structured_results, interpretation,
              conclusion, notes, requested_at, completed_at, created_at, updated_at
       FROM investigations
       WHERE id = $1
       LIMIT 1`,
      investigationId
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function loadPriorInvestigation({ investigationId, patientUid, testName }) {
  if (!patientUid || !testName) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, test_name, result_summary, results, structured_results,
              interpretation, conclusion, notes,
              COALESCE(completed_at, created_at, requested_at) AS recorded_at
       FROM investigations
       WHERE patient_uid = $1::uuid
         AND LOWER(test_name) = LOWER($2)
         AND id <> $3
       ORDER BY COALESCE(completed_at, created_at, requested_at) DESC NULLS LAST
       LIMIT 1`,
      patientUid,
      cleanText(testName),
      investigationId
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

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
    return rows[0] || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
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
       VALUES ($1::uuid, $2::uuid, NULL, $3, $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16,
               $17, $18, $19, $20, $21::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt.version || 'v1',
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
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Lab autoverification generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, NULL, 'pending', $5::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || ['LAB_STAFF', 'DOCTOR', 'PATHOLOGIST', 'ADMIN'],
        source: 'lab_autoverification_delta',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Lab autoverification review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeReviewRow(row) {
  if (!row) return row;
  return {
    ...row,
    result_value: row.result_value === null || row.result_value === undefined ? null : toNumber(row.result_value),
    prior_value: row.prior_value === null || row.prior_value === undefined ? null : toNumber(row.prior_value),
    delta_pct: row.delta_pct === null || row.delta_pct === undefined ? null : toNumber(row.delta_pct),
    reference_low: row.reference_low === null || row.reference_low === undefined ? null : toNumber(row.reference_low),
    reference_high: row.reference_high === null || row.reference_high === undefined ? null : toNumber(row.reference_high),
    critical_low: row.critical_low === null || row.critical_low === undefined ? null : toNumber(row.critical_low),
    critical_high: row.critical_high === null || row.critical_high === undefined ? null : toNumber(row.critical_high),
  };
}

async function insertAutoverification({
  tenantId,
  investigationId,
  patientUid,
  generationId,
  testName,
  resultValue,
  resultText,
  units,
  priorValue,
  priorRecordedAt,
  deltaPct,
  referenceLow,
  referenceHigh,
  criticalLow,
  criticalHigh,
  criticalBand,
  decision,
  decisionReason,
  suggestedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_lab_autoverifications
         (tenant_id, investigation_id, patient_uid, generation_id, test_name,
          result_value, result_text, units, prior_value, prior_recorded_at,
          delta_pct, reference_low, reference_high, critical_low, critical_high,
          critical_band, decision, decision_reason, suggested_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb,
               $20::jsonb, $21::jsonb, 'pending', $22::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, investigation_id, patient_uid, generation_id,
                 test_name, result_value, result_text, units, prior_value,
                 prior_recorded_at, delta_pct, reference_low, reference_high,
                 critical_low, critical_high, critical_band, decision,
                 decision_reason, suggested_actions, source_citations,
                 safety_flags, reviewer_decision, reviewed_by, reviewed_at,
                 reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      investigationId,
      patientUid,
      generationId,
      cleanText(testName),
      resultValue,
      resultText ? cleanText(resultText) : null,
      units ? cleanText(units) : null,
      priorValue,
      priorRecordedAt,
      deltaPct,
      referenceLow,
      referenceHigh,
      criticalLow,
      criticalHigh,
      CRITICAL_BANDS.has(criticalBand) ? criticalBand : 'unknown',
      DECISIONS.has(decision) ? decision : 'pending',
      decisionReason ? cleanText(decisionReason) : null,
      JSON.stringify(suggestedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeReviewRow(rows[0]) || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

function normalizeAiSummary(parsed, fallbackDraft) {
  return {
    ...fallbackDraft,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    decision_reason: cleanText(parsed?.decision_reason) || fallbackDraft.decision_reason,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed?.source_citations),
    ]),
    safety_flags: [
      ...asArray(fallbackDraft.safety_flags),
      ...asArray(parsed?.safety_flags),
    ],
  };
}

export async function evaluateInvestigation({ req = null, investigationId } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeInvestigationId = optionalInt(investigationId, 'investigation_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const investigation = await loadInvestigation(safeInvestigationId);
  if (!investigation) throw AppError.notFound('Investigation not found');

  const testName = cleanText(investigation.test_name);
  if (!testName) throw AppError.badRequest('Investigation has no test_name');

  const patientUid = investigation.patient_uid || investigation.uid || null;
  if (!patientUid) throw AppError.badRequest('Investigation has no patient_uid');

  const resultText = cleanText(
    investigation.result_summary
    || investigation.interpretation
    || investigation.conclusion
    || investigation.notes
    || ''
  );
  const resultValue = extractResultValue(investigation);
  const range = lookupReferenceRange(testName) || {
    units: null,
    reference_low: null,
    reference_high: null,
    critical_low: null,
    critical_high: null,
  };
  const units = extractUnits(investigation, range.units);
  const referenceLow = toNumber(range.reference_low, null);
  const referenceHigh = toNumber(range.reference_high, null);
  const criticalLow = toNumber(range.critical_low, null);
  const criticalHigh = toNumber(range.critical_high, null);
  const abnormalFlag = extractAbnormalFlag(investigation);

  const prior = await loadPriorInvestigation({
    investigationId: safeInvestigationId,
    patientUid,
    testName,
  });
  const priorValue = prior ? extractResultValue(prior) : null;
  const priorRecordedAt = prior?.recorded_at || null;

  const delta = calculateDelta({ currentValue: resultValue, priorValue });
  const criticalBand = classifyCriticalBand({
    value: resultValue,
    referenceLow,
    referenceHigh,
    criticalLow,
    criticalHigh,
  });
  const decisionResult = buildAutoverificationDecision({
    criticalBand,
    deltaPct: delta.delta_pct,
    priorValue,
    hasAbnormalFlags: abnormalFlag,
  });

  const citations = [
    {
      source_type: 'investigation',
      source_id: String(investigation.id),
      label: `${testName} (current)`,
      timestamp: investigation.completed_at || investigation.created_at || investigation.requested_at || null,
    },
  ];
  if (prior) {
    citations.push({
      source_type: 'investigation',
      source_id: String(prior.id),
      label: `${testName} (prior)`,
      timestamp: priorRecordedAt,
    });
  }

  const safetyFlags = [];
  if (criticalBand === 'critical_low' || criticalBand === 'critical_high') {
    safetyFlags.push({
      severity: 'critical',
      code: 'LAB_CRITICAL_VALUE',
      message: `Lab result is in the ${criticalBand.replace('_', ' ')} critical band; escalate to clinician immediately.`,
    });
  }
  if (!prior) {
    safetyFlags.push({
      severity: 'medium',
      code: 'LAB_NO_PRIOR_COMPARISON',
      message: 'No prior result available for delta comparison.',
    });
  }
  if (delta.delta_pct !== null && Math.abs(delta.delta_pct) > LARGE_DELTA_PCT) {
    safetyFlags.push({
      severity: 'high',
      code: 'LAB_LARGE_DELTA',
      message: `Delta of ${delta.delta_pct}% vs prior exceeds ${LARGE_DELTA_PCT}% — specimen or analytical issue possible.`,
    });
  }
  if (abnormalFlag) {
    safetyFlags.push({
      severity: 'medium',
      code: 'LAB_UPSTREAM_ABNORMAL_FLAG',
      message: 'Upstream analyzer / LIS flagged result as abnormal.',
    });
  }

  const fallbackDraft = {
    test_name: testName,
    result_value: resultValue,
    result_text: resultText || null,
    units: units || null,
    prior_value: priorValue,
    prior_recorded_at: priorRecordedAt,
    delta_pct: delta.delta_pct,
    reference_low: referenceLow,
    reference_high: referenceHigh,
    critical_low: criticalLow,
    critical_high: criticalHigh,
    critical_band: criticalBand,
    decision: decisionResult.decision,
    decision_reason: decisionResult.decision_reason,
    suggested_actions: decisionResult.suggested_actions,
    summary: `${testName}: ${decisionResult.decision} (${criticalBand}).`,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { provider: 'template', model: null, usedAi: false, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        rules_draft: fallbackDraft,
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Lab autoverification AI narrative failed; using template', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  const mergedCitations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );
  const mergedSafetyFlags = [
    ...safetyFlags,
    ...asArray(parsed?.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: fallbackDraft,
      citations: mergedCitations,
    }),
  ];
  draft.source_citations = mergedCitations;
  draft.safety_flags = mergedSafetyFlags;

  const generation = await insertGeneration({
    tenantId,
    patientUid,
    prompt,
    sourceHashValue: sourceHash({
      investigation_id: safeInvestigationId,
      test_name: testName,
      result_value: resultValue,
      prior_value: priorValue,
      critical_band: criticalBand,
      decision: decisionResult.decision,
    }),
    draft,
    citations: mergedCitations,
    safetyFlags: mergedSafetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      investigation_id: safeInvestigationId,
      test_name: testName,
      critical_band: criticalBand,
      decision: decisionResult.decision,
      delta_pct: delta.delta_pct,
      rules_authoritative: true,
    },
  });

  const reviewRow = await insertAutoverification({
    tenantId,
    investigationId: safeInvestigationId,
    patientUid,
    generationId: generation?.id || null,
    testName,
    resultValue,
    resultText: resultText || null,
    units,
    priorValue,
    priorRecordedAt,
    deltaPct: delta.delta_pct,
    referenceLow,
    referenceHigh,
    criticalLow,
    criticalHigh,
    criticalBand,
    decision: decisionResult.decision,
    decisionReason: decisionResult.decision_reason,
    suggestedActions: decisionResult.suggested_actions,
    citations: mergedCitations,
    safetyFlags: mergedSafetyFlags,
    metadata: {
      used_ai: Boolean(aiResult.usedAi),
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      rules_authoritative: true,
    },
  });

  if (!reviewRow) {
    return {
      review_id: null,
      generation_id: generation?.id || null,
      clinical_review_id: null,
      draft,
      source_citations: mergedCitations,
      safety_flags: mergedSafetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_lab_autoverifications_unavailable',
      decision: decisionResult.decision,
      critical_band: criticalBand,
      ai_metadata: {
        provider: aiResult.provider || 'template',
        model: aiResult.model || null,
        used_ai: Boolean(aiResult.usedAi),
        usage: aiResult.usage || {},
      },
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.lab_autoverification_generated',
    aggregateType: 'clinical_ai_lab_autoverification',
    aggregateId: reviewRow.id,
    patientUid,
    payload: {
      tenant_id: tenantId,
      investigation_id: safeInvestigationId,
      review_id: reviewRow.id,
      generation_id: generation?.id || null,
      test_name: testName,
      decision: decisionResult.decision,
      critical_band: criticalBand,
      delta_pct: delta.delta_pct,
    },
  });

  return {
    review_id: reviewRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    review: reviewRow,
    source_citations: mergedCitations,
    safety_flags: mergedSafetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    decision: decisionResult.decision,
    critical_band: criticalBand,
    review_status: clinicalReview?.decision || reviewRow.reviewer_decision || 'pending',
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listLabAutoverifications({
  tenantId = null,
  patientUid = null,
  decision = null,
  criticalBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedBand = criticalBand && CRITICAL_BANDS.has(cleanText(criticalBand).toLowerCase())
    ? cleanText(criticalBand).toLowerCase()
    : null;
  const normalizedReviewer = reviewerDecision && REVIEWER_DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.investigation_id, r.patient_uid, u.name AS patient_name,
              r.generation_id, r.test_name, r.result_value, r.result_text, r.units,
              r.prior_value, r.prior_recorded_at, r.delta_pct,
              r.reference_low, r.reference_high, r.critical_low, r.critical_high,
              r.critical_band, r.decision, r.decision_reason, r.suggested_actions,
              r.source_citations, r.safety_flags, r.reviewer_decision,
              r.reviewed_by, r.reviewed_at, r.reviewer_note, r.metadata,
              r.created_at, r.updated_at
       FROM clinical_ai_lab_autoverifications r
       LEFT JOIN users u ON u.uid = r.patient_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR r.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR r.decision = $3)
         AND ($4::text IS NULL OR r.critical_band = $4)
         AND ($5::text IS NULL OR r.reviewer_decision = $5)
       ORDER BY
         CASE r.critical_band
           WHEN 'critical_high' THEN 0
           WHEN 'critical_low' THEN 0
           WHEN 'borderline_high' THEN 1
           WHEN 'borderline_low' THEN 1
           WHEN 'normal' THEN 2
           ELSE 3
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      patientUid || null,
      normalizedDecision,
      normalizedBand,
      normalizedReviewer,
      safeLimit
    );
    const normalized = rows.map(normalizeReviewRow);
    return { autoverifications: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { autoverifications: [], count: 0 };
    throw err;
  }
}

export async function decideLabAutoverification({
  tenantId = null,
  reviewId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_REVIEWER_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_lab_autoverifications
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, investigation_id, patient_uid, generation_id, test_name,
               result_value, units, critical_band, decision, decision_reason,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(reviewId, 'review_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Lab autoverification review not found');

  // Results-inbox wiring (#4): an ACCEPTED autoverification is a confirmed
  // actionable result — promote it into the ack-tracked results inbox. The
  // bridge gates on the module being enabled and never throws; the outer guard
  // ensures a wiring hiccup never blocks the decision response.
  if (normalized === 'accepted') {
    try {
      const { promoteLabAutoverification } = await import('../results/resultsInboxService.js');
      await promoteLabAutoverification(rows[0], { tenantId: tid });
    } catch (err) {
      logger.warn('promoteLabAutoverification wiring failed', { error: err?.message });
    }
  }
  return normalizeReviewRow(rows[0]);
}

export default {
  buildAutoverificationDecision,
  calculateDelta,
  classifyCriticalBand,
  decideLabAutoverification,
  evaluateInvestigation,
  listLabAutoverifications,
  lookupReferenceRange,
};
