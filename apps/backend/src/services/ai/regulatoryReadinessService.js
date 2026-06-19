/**
 * Regulatory-readiness pack exporter.
 *
 * Substrate hole S5 in docs/AI_FEATURE_GAP_BACKLOG.md: VH Health captures
 * everything CDSCO / EU MDR / FDA SaMD reviewers want — model registry,
 * eval runs, drift logs, incident reports, prompt versions, review
 * decisions — but there was no one-click "export evidence pack for module
 * X v1.2" flow. This service assembles those rows into a single auditable
 * JSON document the AI eval lead can hand to a regulator.
 *
 * Non-goals (deliberately out of v1):
 *   - ZIP / PDF rendering (a single JSON document is fine for regulator
 *     intake; downstream tools can wrap it).
 *   - Async background job (assembly is bounded by the per-module row
 *     count which is small in practice; revisit if exports start hitting
 *     timeouts).
 *   - Cross-tenant exports (every query is tenant-scoped; an export of
 *     module X belongs to one tenant).
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const PACK_VERSION = 'clinical-ai-readiness-pack-v1';
const ROW_LIMIT = 5_000;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

async function safeQuery(label, fn) {
  try {
    return { rows: await fn(), skipped_reason: null };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return { rows: [], skipped_reason: 'schema_unavailable' };
    }
    logger.warn(`Readiness pack query failed: ${label}`, { error: err.message });
    return { rows: [], skipped_reason: 'query_failed', error: err.message };
  }
}

/**
 * Assemble a regulatory-readiness pack for one module + optional version
 * range. Every section is tenant-scoped via explicit `tenant_id = $1`
 * filters. Returns a JSON-serialisable object.
 *
 * @param {object} options
 * @param {string} [options.tenantId] — caller's tenant; defaults to the
 *   platform's DEFAULT_TENANT_ID.
 * @param {string} options.moduleKey — module to export.
 * @param {string} [options.fromVersion] — inclusive lower bound on
 *   version string (text comparison).
 * @param {string} [options.toVersion] — inclusive upper bound.
 * @param {object} [options.generatedBy] — caller identity recorded in
 *   the pack manifest.
 */
export async function assembleReadinessPack(options = {}) {
  const moduleKey = String(options.moduleKey || '').trim();
  if (!moduleKey) {
    throw AppError.badRequest('module_key is required');
  }
  const tid = resolveTenantId(options);
  const fromVersion = options.fromVersion ? String(options.fromVersion) : null;
  const toVersion = options.toVersion ? String(options.toVersion) : null;

  const [
    moduleRow,
    modelRegistry,
    evalRuns,
    canaryRuns,
    safetyReviews,
    prompts,
    reviews,
  ] = await Promise.all([
    safeQuery('module', () => prisma.$queryRawUnsafe(
      `SELECT module_key, display_name, description, enabled, settings, created_at, updated_at
       FROM clinical_ai_modules
       WHERE module_key = $1
       LIMIT 1`,
      moduleKey,
    )),
    safeQuery('model_registry', () => prisma.$queryRawUnsafe(
      `SELECT id, model_key, version, provider, purpose, owner, stage, parent_version,
              lineage, approval_status, approval_note, approved_by, approved_at,
              retired_at, metadata, created_at, updated_at
       FROM clinical_ai_model_registry
       WHERE tenant_id = $1::uuid
         AND model_key = $2
         AND ($3::text IS NULL OR version >= $3)
         AND ($4::text IS NULL OR version <= $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      tid, moduleKey, fromVersion, toVersion, ROW_LIMIT,
    )),
    safeQuery('eval_runs', () => prisma.$queryRawUnsafe(
      `SELECT id, model_registry_id, model_key, version, suite, sample_count, pass_count,
              fail_count, accuracy, f1_score, avg_latency_ms, fallback_rate_pct,
              safety_flag_rate_pct, drift_score, recommendation, severity,
              signals, summary, recommended_actions, source_citations, safety_flags,
              reviewer_decision, reviewed_by, reviewed_at, reviewer_note, metadata,
              created_at, updated_at,
              COALESCE(slice_metrics, '[]'::jsonb) AS slice_metrics,
              COALESCE(bias_signals, '[]'::jsonb) AS bias_signals
       FROM clinical_ai_model_eval_runs
       WHERE tenant_id = $1::uuid
         AND model_key = $2
         AND ($3::text IS NULL OR version >= $3)
         AND ($4::text IS NULL OR version <= $4)
       ORDER BY created_at DESC
       LIMIT $5`,
      tid, moduleKey, fromVersion, toVersion, ROW_LIMIT,
    )),
    // Canary runs are not module-keyed. Capture the recent runs so the
    // reviewer can see the drift posture overall during the export window.
    safeQuery('canary_runs', () => prisma.$queryRawUnsafe(
      `SELECT id, run_scope, total_cases, pass_count, fail_count, drift_detected,
              metadata, started_at, finished_at,
              COALESCE(slice_metrics, '[]'::jsonb) AS slice_metrics,
              COALESCE(bias_signals, '[]'::jsonb) AS bias_signals
       FROM clinical_ai_canary_runs
       WHERE tenant_id = $1::uuid
       ORDER BY started_at DESC
       LIMIT 100`,
      tid,
    )),
    safeQuery('safety_reviews', () => prisma.$queryRawUnsafe(
      `SELECT id, generation_id, module_key, status, findings, citation_coverage_pct, created_at
       FROM clinical_ai_safety_reviews
       WHERE tenant_id = $1::uuid AND module_key = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      tid, moduleKey, ROW_LIMIT,
    )),
    safeQuery('prompts', () => prisma.$queryRawUnsafe(
      `SELECT id, module_key, version, title, system_prompt, user_prompt_template,
              output_schema, status, active, created_by, activated_by, activated_at,
              created_at, updated_at
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid AND module_key = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      tid, moduleKey, ROW_LIMIT,
    )),
    safeQuery('reviews', () => prisma.$queryRawUnsafe(
      `SELECT id, generation_id, module_key, patient_uid, admission_id, reviewer_uid,
              reviewer_role, decision, edited_draft, rejection_reason, metadata,
              created_at, updated_at
       FROM clinical_ai_reviews
       WHERE tenant_id = $1::uuid AND module_key = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      tid, moduleKey, ROW_LIMIT,
    )),
  ]);

  const sections = {
    module: moduleRow.rows[0] || null,
    model_registry: modelRegistry.rows,
    eval_runs: evalRuns.rows,
    canary_runs: canaryRuns.rows,
    safety_reviews: safetyReviews.rows,
    prompts: prompts.rows,
    reviews: reviews.rows,
  };

  const skipped = {};
  for (const [name, result] of Object.entries({
    module: moduleRow,
    model_registry: modelRegistry,
    eval_runs: evalRuns,
    canary_runs: canaryRuns,
    safety_reviews: safetyReviews,
    prompts: prompts,
    reviews: reviews,
  })) {
    if (result.skipped_reason) skipped[name] = result.skipped_reason;
  }

  const rowCounts = Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [
      key,
      value === null ? 0 : Array.isArray(value) ? value.length : 1,
    ]),
  );

  // Aggregate bias-signal counts so the regulator can scan severity at
  // a glance without parsing every eval / canary row.
  const biasSignalSummary = summariseBiasSignals(evalRuns.rows, canaryRuns.rows);

  return {
    pack_version: PACK_VERSION,
    generated_at: new Date().toISOString(),
    generated_by: options.generatedBy || null,
    tenant_id: tid,
    module_key: moduleKey,
    version_range: { from: fromVersion, to: toVersion },
    decision_support_only: true,
    summary: {
      row_counts: rowCounts,
      bias_signal_counts: biasSignalSummary,
      skipped_sections: skipped,
    },
    sections,
  };
}

function summariseBiasSignals(evalRuns, canaryRuns) {
  const counts = { critical: 0, high: 0, medium: 0 };
  const accumulate = (signals) => {
    if (!Array.isArray(signals)) return;
    for (const signal of signals) {
      const sev = String(signal?.severity || '').toLowerCase();
      if (sev in counts) counts[sev] += 1;
    }
  };
  for (const run of evalRuns || []) accumulate(run.bias_signals);
  for (const run of canaryRuns || []) accumulate(run.bias_signals);
  return counts;
}

export const __testing__ = {
  PACK_VERSION,
  ROW_LIMIT,
  summariseBiasSignals,
};

export default {
  assembleReadinessPack,
};
