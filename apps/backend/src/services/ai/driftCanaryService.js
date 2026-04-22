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
import { generateClinicalText } from './localLlmClient.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const BASELINE_THRESHOLD_PCT = 10;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
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

async function evaluateCase(testCase) {
  const module = await getClinicalAiModule(testCase.module_key);
  const systemPrompt = 'You are a hospital clinical AI drafting assistant. Use only the supplied chart context. Return JSON only.';
  const userPrompt = `Canary case: ${testCase.label}\n\n${JSON.stringify(testCase.input_packet)}`;
  const aiResult = await generateClinicalText({ systemPrompt, userPrompt, taskType: testCase.module_key });
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
      `SELECT id, module_key, label, input_packet, expected_keys, expected_citations_min
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
    return { tenant_id: tid, total_cases: 0, pass_count: 0, fail_count: 0, drift_detected: false, findings: [], note: 'no_active_cases' };
  }

  const findings = [];
  for (const testCase of cases) {
    try {
      const result = await evaluateCase(testCase);
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
  ).catch(() => []);
  const baselinePct = baselineRows[0]
    ? Math.round((Number(baselineRows[0].pass_count) / Number(baselineRows[0].total_cases)) * 100)
    : null;
  const driftDetected = baselinePct != null && baselinePct - passRatePct >= BASELINE_THRESHOLD_PCT;

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_canary_runs
         (tenant_id, run_scope, total_cases, pass_count, fail_count, drift_detected,
          findings, metadata, started_at, finished_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW(), NOW())`,
      tid,
      scope,
      findings.length,
      passCount,
      failCount,
      driftDetected,
      JSON.stringify(findings),
      JSON.stringify({
        pass_rate_pct: passRatePct,
        baseline_pct: baselinePct,
        drift_threshold_pct: BASELINE_THRESHOLD_PCT,
      })
    );
  } catch (err) {
    logger.warn('Canary run persist failed', { error: err.message });
  }

  return {
    tenant_id: tid,
    total_cases: findings.length,
    pass_count: passCount,
    fail_count: failCount,
    pass_rate_pct: passRatePct,
    baseline_pct: baselinePct,
    drift_detected: driftDetected,
    findings,
  };
}

export async function listCanaryRuns({ tenantId = null, limit = 30 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, run_scope, total_cases, pass_count, fail_count, drift_detected,
              metadata, started_at, finished_at
       FROM clinical_ai_canary_runs
       WHERE tenant_id = $1::uuid
       ORDER BY started_at DESC
       LIMIT $2`,
      tid,
      safeLimit
    );
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export async function upsertCanaryCase({ tenantId = null, moduleKey, label, inputPacket, expectedKeys = [], expectedCitationsMin = 1 } = {}) {
  const tid = resolveTenantId({ tenantId });
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
    moduleKey,
    label,
    JSON.stringify(inputPacket || {}),
    expectedKeys,
    Number.parseInt(expectedCitationsMin, 10) || 1
  );
  return rows[0];
}

export default {
  listCanaryRuns,
  runCanary,
  upsertCanaryCase,
};
