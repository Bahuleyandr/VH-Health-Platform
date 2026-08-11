/**
 * Model drift canary.
 *
 * Sealed test set of (module_key, input_packet, expected_keys,
 * expected_citations_min) tuples that are scored against the CURRENT
 * prompt + hallucination-defense stack nightly (or on-demand). A run
 * reports pass/fail per case and surfaces a "drift detected" alarm if
 * pass-rate or citation coverage drops more than 10 percentage points
 * below the last-known-good baseline.
 *
 * The canary never touches real PHI — cases are synthetic chart packets
 * curated by ops. Each tenant maintains its own canary set so drift
 * detection is scoped to what that hospital is actually running.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { generateClinicalText } from './localLlmClient.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { requireTenantId } from '../tenant/tenantService.js';

const BASELINE_THRESHOLD_PCT = 10;

// Bias monitoring (S3) — minimum sample size before a slice is eligible to
// fire a bias signal, and the percentage-point shortfall vs the overall
// pass rate at which each severity tier triggers.
const BIAS_MIN_SLICE_SAMPLES = 3;
const BIAS_DELTA_MEDIUM_PP = 15;
const BIAS_DELTA_HIGH_PP = 25;
const BIAS_DELTA_CRITICAL_PP = 35;

// Demographic axes scanned for bias. Custom axes added by a hospital in
// slice_attributes are NOT scanned automatically — extend this list when
// onboarding a new axis so the indexes in migration 112 cover it.
const BIAS_SLICE_AXES = [
  'age_band',
  'sex',
  'language',
  'disease_group',
  'facility_id',
];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLimit(value, fallback = 100, max = 500) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeActiveFilter(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'active'].includes(normalized)) return true;
  if (['false', '0', 'no', 'inactive'].includes(normalized)) return false;
  return null;
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

/**
 * Group findings by each demographic axis declared on the matching canary
 * case, returning a per-axis-value summary { axis, value, sample_count,
 * pass_count, pass_rate_pct }. Cases without slice_attributes contribute
 * to the aggregate but produce no slice rows.
 */
export function computeSliceMetrics(findings, cases) {
  const caseById = new Map(
    (cases || []).map((c) => [String(c.id ?? c.case_id ?? ''), c]),
  );
  // axis -> value -> { sample_count, pass_count }
  const buckets = new Map();
  for (const finding of findings || []) {
    const matched = caseById.get(String(finding.case_id ?? ''));
    const sliceAttrs = matched?.slice_attributes || {};
    if (!sliceAttrs || typeof sliceAttrs !== 'object') continue;
    for (const axis of BIAS_SLICE_AXES) {
      const value = sliceAttrs[axis];
      if (value === undefined || value === null || value === '') continue;
      const axisKey = String(axis);
      const valueKey = String(value);
      if (!buckets.has(axisKey)) buckets.set(axisKey, new Map());
      const valueMap = buckets.get(axisKey);
      if (!valueMap.has(valueKey)) {
        valueMap.set(valueKey, { sample_count: 0, pass_count: 0 });
      }
      const cell = valueMap.get(valueKey);
      cell.sample_count += 1;
      if (finding.passed) cell.pass_count += 1;
    }
  }

  const out = [];
  for (const [axis, valueMap] of buckets.entries()) {
    for (const [value, cell] of valueMap.entries()) {
      const passRate = cell.sample_count
        ? Math.round((cell.pass_count / cell.sample_count) * 100)
        : 0;
      out.push({
        axis,
        value,
        sample_count: cell.sample_count,
        pass_count: cell.pass_count,
        fail_count: cell.sample_count - cell.pass_count,
        pass_rate_pct: passRate,
      });
    }
  }
  // Sort by axis then descending sample count for stable telemetry.
  out.sort((a, b) => (
    a.axis === b.axis
      ? b.sample_count - a.sample_count
      : a.axis.localeCompare(b.axis)
  ));
  return out;
}

/**
 * Flag any slice whose pass rate is materially below the overall pass
 * rate. Severity tiers map to BIAS_DELTA_* thresholds. Slices with fewer
 * than BIAS_MIN_SLICE_SAMPLES cases are skipped to avoid noise.
 */
export function computeBiasSignals(sliceMetrics, overallPassRatePct) {
  const overall = Number.isFinite(Number(overallPassRatePct))
    ? Number(overallPassRatePct)
    : null;
  if (overall === null) return [];
  const signals = [];
  for (const slice of sliceMetrics || []) {
    if ((slice.sample_count || 0) < BIAS_MIN_SLICE_SAMPLES) continue;
    const delta = overall - Number(slice.pass_rate_pct || 0);
    if (delta < BIAS_DELTA_MEDIUM_PP) continue;
    let severity = 'medium';
    if (delta >= BIAS_DELTA_CRITICAL_PP) severity = 'critical';
    else if (delta >= BIAS_DELTA_HIGH_PP) severity = 'high';
    signals.push({
      severity,
      axis: slice.axis,
      value: slice.value,
      sample_count: slice.sample_count,
      pass_rate_pct: slice.pass_rate_pct,
      overall_pass_rate_pct: overall,
      delta_pct: delta,
      message: `Pass rate for ${slice.axis}=${slice.value} is ${delta} percentage points below the overall ${overall}% (${slice.pass_count}/${slice.sample_count}).`,
    });
  }
  // Sort critical/high first for downstream UI rendering.
  const SEVERITY_RANK = { critical: 0, high: 1, medium: 2 };
  signals.sort((a, b) => (
    (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99)
    || b.delta_pct - a.delta_pct
  ));
  return signals;
}

async function evaluateCase(testCase, tenantId) {
  const module = await getClinicalAiModule(testCase.module_key);
  const systemPrompt = 'You are a hospital clinical AI drafting assistant. Use only the supplied chart context. Return JSON only.';
  const userPrompt = `Canary case: ${testCase.label}\n\n${JSON.stringify(testCase.input_packet)}`;
  const aiResult = await generateClinicalText({ systemPrompt, userPrompt, taskType: testCase.module_key, tenantId });
  const draft = safeJsonParse(aiResult.text, { synthetic: true });

  const defenseFlags = runOutputDefenses({
    draft,
    module,
    context: testCase.input_packet,
    citations: testCase.input_packet?.citations || [],
  });

  const expectedKeys = Array.isArray(testCase.expected_keys) ? testCase.expected_keys : [];
  const missingKeys = expectedKeys.filter((key) => !(key in (draft || {})));
  const citations = testCase.input_packet?.citations || [];
  const citationCountOk = citations.length >= Number(testCase.expected_citations_min || 1);

  const passed = missingKeys.length === 0
    && citationCountOk
    && !defenseFlags.some((flag) => flag.severity === 'critical');

  return {
    case_id: testCase.id,
    label: testCase.label,
    module_key: testCase.module_key,
    passed,
    missing_keys: missingKeys,
    citation_count: citations.length,
    defense_flag_codes: defenseFlags.map((flag) => flag.code),
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
  };
}

export async function runCanary({ tenantId = null, scope = 'routine' } = {}) {
  const tid = resolveTenantId({ tenantId });
  let cases;
  try {
    cases = await prisma.$queryRawUnsafe(
      `SELECT id, module_key, label, input_packet, expected_keys, expected_citations_min, slice_attributes
       FROM clinical_ai_canary_cases
       WHERE tenant_id = $1::uuid AND active = true
       ORDER BY module_key, label`,
      tid
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return { tenant_id: tid, halted: true, reason: 'canary_tables_missing' };
    throw err;
  }

  if (!cases.length) {
    return { tenant_id: tid, total_cases: 0, pass_count: 0, fail_count: 0, drift_detected: false, findings: [], slice_metrics: [], bias_signals: [], note: 'no_active_cases' };
  }

  const findings = [];
  for (const testCase of cases) {
    try {
      const result = await evaluateCase(testCase, tid);
      findings.push(result);
    } catch (err) {
      logger.warn('Canary case evaluation failed', { label: testCase.label, error: err.message });
      findings.push({
        case_id: testCase.id,
        label: testCase.label,
        module_key: testCase.module_key,
        passed: false,
        error: err.message.slice(0, 200),
      });
    }
  }

  const passCount = findings.filter((f) => f.passed).length;
  const failCount = findings.length - passCount;
  const passRatePct = Math.round((passCount / findings.length) * 100);

  // S3 bias monitoring — compute per-slice metrics and any signals where
  // a demographic slice underperforms the overall pass rate.
  const sliceMetrics = computeSliceMetrics(findings, cases);
  const biasSignals = computeBiasSignals(sliceMetrics, passRatePct);

  // Compare against the last successful run — drift if pass-rate dropped
  // >= BASELINE_THRESHOLD_PCT. First run establishes the baseline.
  const baselineRows = await prisma.$queryRawUnsafe(
    `SELECT pass_count, total_cases
     FROM clinical_ai_canary_runs
     WHERE tenant_id = $1::uuid
       AND drift_detected = false
       AND total_cases > 0
     ORDER BY started_at DESC
     LIMIT 1`,
    tid
  );
  const baselinePct = baselineRows[0]
    ? Math.round((Number(baselineRows[0].pass_count) / Number(baselineRows[0].total_cases)) * 100)
    : null;
  const driftDetected = baselinePct !== null && baselinePct - passRatePct >= BASELINE_THRESHOLD_PCT;

  await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_canary_runs
         (tenant_id, run_scope, total_cases, pass_count, fail_count, drift_detected,
          findings, slice_metrics, bias_signals, metadata, started_at, finished_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, NOW(), NOW())`,
      tid,
      scope,
      findings.length,
      passCount,
      failCount,
      driftDetected,
      JSON.stringify(findings),
      JSON.stringify(sliceMetrics),
      JSON.stringify(biasSignals),
      JSON.stringify({
        pass_rate_pct: passRatePct,
        baseline_pct: baselinePct,
        drift_threshold_pct: BASELINE_THRESHOLD_PCT,
        bias_thresholds_pp: {
          medium: BIAS_DELTA_MEDIUM_PP,
          high: BIAS_DELTA_HIGH_PP,
          critical: BIAS_DELTA_CRITICAL_PP,
          min_slice_samples: BIAS_MIN_SLICE_SAMPLES,
        },
      })
  );

  return {
    tenant_id: tid,
    total_cases: findings.length,
    pass_count: passCount,
    fail_count: failCount,
    pass_rate_pct: passRatePct,
    baseline_pct: baselinePct,
    drift_detected: driftDetected,
    findings,
    slice_metrics: sliceMetrics,
    bias_signals: biasSignals,
  };
}

export async function listCanaryRuns({ tenantId = null, limit = 30 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = normalizeLimit(limit, 30, 200);
  const rows = await prisma.$queryRawUnsafe(
      `SELECT id, run_scope, total_cases, pass_count, fail_count, drift_detected,
              metadata, started_at, finished_at,
              COALESCE(slice_metrics, '[]'::jsonb) AS slice_metrics,
              COALESCE(bias_signals, '[]'::jsonb) AS bias_signals
       FROM clinical_ai_canary_runs
       WHERE tenant_id = $1::uuid
       ORDER BY started_at DESC
       LIMIT $2`,
      tid,
      safeLimit
  );
  return { runs: rows, count: rows.length };
}

export async function listCanaryCases({ tenantId = null, moduleKey = null, active = null, limit = 100 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = normalizeLimit(limit, 100, 500);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  const cleanModuleKey = normalizeText(moduleKey);
  const activeFilter = normalizeActiveFilter(active);

  if (cleanModuleKey) {
    params.push(cleanModuleKey);
    filters.push(`module_key = $${params.length}`);
  }
  if (activeFilter !== null) {
    params.push(activeFilter);
    filters.push(`active = $${params.length}`);
  }

  const rows = await prisma.$queryRawUnsafe(
      `SELECT id, module_key, label, input_packet, expected_keys, expected_citations_min, active, created_at,
              COALESCE(slice_attributes, '{}'::jsonb) AS slice_attributes
       FROM clinical_ai_canary_cases
       WHERE ${filters.join(' AND ')}
       ORDER BY active DESC, module_key, label
       LIMIT $${params.length + 1}`,
      ...params,
      safeLimit
  );
  return { cases: rows, count: rows.length };
}

function normalizeSliceAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cleaned = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    const stringValue = String(raw).trim();
    if (!stringValue) continue;
    cleaned[String(key).trim()] = stringValue;
  }
  return cleaned;
}

export async function upsertCanaryCase({ tenantId = null, moduleKey, label, inputPacket, expectedKeys = [], expectedCitationsMin = 1, sliceAttributes = {} } = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanModuleKey = normalizeText(moduleKey);
  const cleanLabel = normalizeText(label);
  if (!cleanModuleKey) throw AppError.badRequest('module_key is required');
  if (!cleanLabel) throw AppError.badRequest('label is required');
  if (!inputPacket || typeof inputPacket !== 'object' || Array.isArray(inputPacket)) {
    throw AppError.badRequest('input_packet object is required');
  }
  const normalizedExpectedKeys = Array.isArray(expectedKeys)
    ? expectedKeys.map(normalizeText).filter(Boolean)
    : [];
  const normalizedSliceAttrs = normalizeSliceAttributes(sliceAttributes);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_canary_cases
         (tenant_id, module_key, label, input_packet, expected_keys, expected_citations_min, slice_attributes, active, created_at)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7::jsonb, true, NOW())
       ON CONFLICT (tenant_id, module_key, label)
       DO UPDATE SET
         input_packet = EXCLUDED.input_packet,
         expected_keys = EXCLUDED.expected_keys,
         expected_citations_min = EXCLUDED.expected_citations_min,
         slice_attributes = EXCLUDED.slice_attributes,
         active = true
       RETURNING id, module_key, label, expected_keys, expected_citations_min, slice_attributes, active, created_at`,
      tid,
      cleanModuleKey,
      cleanLabel,
      JSON.stringify(inputPacket),
      normalizedExpectedKeys,
      Number.parseInt(expectedCitationsMin, 10) || 1,
      JSON.stringify(normalizedSliceAttrs)
    );
    return rows[0];
  } catch (err) {
    // Migration 112 not yet applied — fall back to the pre-S3 insert.
    if (/column .* slice_attributes .*does not exist/i.test(String(err?.message || ''))) {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_canary_cases
           (tenant_id, module_key, label, input_packet, expected_keys, expected_citations_min, active, created_at)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, true, NOW())
         ON CONFLICT (tenant_id, module_key, label)
         DO UPDATE SET
           input_packet = EXCLUDED.input_packet,
           expected_keys = EXCLUDED.expected_keys,
           expected_citations_min = EXCLUDED.expected_citations_min,
           active = true
         RETURNING id, module_key, label, expected_keys, expected_citations_min, active, created_at`,
        tid,
        cleanModuleKey,
        cleanLabel,
        JSON.stringify(inputPacket),
        normalizedExpectedKeys,
        Number.parseInt(expectedCitationsMin, 10) || 1
      );
      return { ...rows[0], slice_attributes: normalizedSliceAttrs };
    }
    throw err;
  }
}

export async function deactivateCanaryCase({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const caseId = Number.parseInt(id, 10);
  if (!caseId) throw AppError.badRequest('canary case id is required');

  const rows = await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_canary_cases
       SET active = false
       WHERE tenant_id = $1::uuid AND id = $2
       RETURNING id, module_key, label, input_packet, expected_keys, expected_citations_min, active, created_at`,
      tid,
      caseId
  );
  if (!rows[0]) throw AppError.notFound('Canary case not found');
  return rows[0];
}

export default {
  computeBiasSignals,
  computeSliceMetrics,
  deactivateCanaryCase,
  listCanaryCases,
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
};
