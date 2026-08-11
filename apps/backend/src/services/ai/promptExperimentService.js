/**
 * Prompt A/B testing.
 *
 * Lets admins pit two active-candidate prompts against each other on real
 * traffic with a configurable split. For each draft generation, we pick a
 * variant deterministically from the generation id so tests are
 * reproducible; record the (experiment, variant) → generation mapping;
 * and later compute acceptance / rejection / fidelity rates per variant.
 *
 * Invariants:
 *   - Experiments are tenant-scoped.
 *   - A module can have at most one running experiment per tenant at a time.
 *   - Variant selection is deterministic on generation_id so re-runs are
 *     idempotent; no DB update is required before the draft is saved.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function variantForHash(hash, splitA) {
  // Deterministic 0..1 from first 8 hex chars; variant A if below splitA.
  const num = parseInt(String(hash).slice(0, 8) || '0', 16);
  return num / 0xffffffff < splitA ? 'A' : 'B';
}

export async function getActiveExperimentForModule({ tenantId = null, moduleKey } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
      `SELECT e.id, e.tenant_id, e.module_key, e.name, e.variant_a_prompt_id, e.variant_b_prompt_id,
              e.traffic_split_a, e.status, e.started_at, e.metadata,
              pa.version AS variant_a_version, pa.system_prompt AS variant_a_system, pa.user_prompt_template AS variant_a_user,
              pb.version AS variant_b_version, pb.system_prompt AS variant_b_system, pb.user_prompt_template AS variant_b_user
       FROM clinical_ai_prompt_experiments e
       LEFT JOIN clinical_ai_prompts pa ON pa.id = e.variant_a_prompt_id
       LEFT JOIN clinical_ai_prompts pb ON pb.id = e.variant_b_prompt_id
       WHERE e.tenant_id = $1::uuid
         AND e.module_key = $2
         AND e.status = 'running'
       ORDER BY e.started_at DESC
       LIMIT 1`,
      tid,
      moduleKey
  );
  return rows[0] || null;
}

/**
 * Given a generation hash (we use the source_hash from the workflow service),
 * pick a variant deterministically. Returns null if no experiment is running.
 */
export async function pickVariant({ tenantId = null, moduleKey, hash }) {
  const exp = await getActiveExperimentForModule({ tenantId, moduleKey });
  if (!exp) return null;
  const variant = variantForHash(hash, Number(exp.traffic_split_a || 0.5));
  const promptId = variant === 'A' ? exp.variant_a_prompt_id : exp.variant_b_prompt_id;
  return {
    experiment_id: exp.id,
    variant,
    prompt_id: promptId,
    version: variant === 'A' ? exp.variant_a_version : exp.variant_b_version,
    system_prompt: variant === 'A' ? exp.variant_a_system : exp.variant_b_system,
    user_prompt_template: variant === 'A' ? exp.variant_a_user : exp.variant_b_user,
  };
}

export async function recordAssignment({ tenantId = null, experimentId, generationId, variant }) {
  const tid = resolveTenantId({ tenantId });
  await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_prompt_assignments
         (tenant_id, experiment_id, generation_id, variant)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (generation_id) DO NOTHING`,
      tid,
      experimentId,
      generationId,
      variant
  );
}

export async function createExperiment({ tenantId = null, moduleKey, name, variantAPromptId, variantBPromptId, trafficSplitA = 0.5, startedBy = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!moduleKey) throw AppError.badRequest('moduleKey is required');
  if (!variantAPromptId || !variantBPromptId) {
    throw AppError.badRequest('variantAPromptId and variantBPromptId are required');
  }
  if (variantAPromptId === variantBPromptId) {
    throw AppError.badRequest('Variants must reference different prompts');
  }

  // At most one running experiment per module per tenant.
  const existing = await getActiveExperimentForModule({ tenantId: tid, moduleKey });
  if (existing) {
    throw AppError.conflict(`A running experiment already exists for ${moduleKey}. Conclude it before starting a new one.`);
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prompt_experiments
       (tenant_id, module_key, name, variant_a_prompt_id, variant_b_prompt_id,
        traffic_split_a, status, started_by, started_at, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 'running', $7::uuid, NOW(), NOW(), NOW())
     RETURNING id, tenant_id, module_key, name, variant_a_prompt_id, variant_b_prompt_id,
               traffic_split_a, status, started_by, started_at, created_at`,
    tid,
    moduleKey,
    String(name || `${moduleKey} A/B ${Date.now()}`),
    Number.parseInt(variantAPromptId, 10),
    Number.parseInt(variantBPromptId, 10),
    Number(trafficSplitA),
    startedBy
  );
  return rows[0];
}

export async function concludeExperiment({ tenantId = null, experimentId, winningVariant = null, concludedBy = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_prompt_experiments
     SET status = 'concluded',
         winning_variant = $3,
         concluded_at = NOW(),
         metadata = metadata || $4::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'running'
     RETURNING id, tenant_id, module_key, name, status, winning_variant, concluded_at`,
    Number.parseInt(experimentId, 10),
    tid,
    winningVariant || null,
    JSON.stringify({ concluded_by: concludedBy || null })
  );
  if (!rows[0]) throw AppError.notFound('Running experiment not found');
  return rows[0];
}

/**
 * Roll up acceptance + rejection + fidelity stats per variant for a given
 * experiment. Returns { variant_a, variant_b, sample_counts, winner_hint }
 * where winner_hint is set when one variant has a >=10pp higher acceptance
 * rate on at least 20 samples each.
 */
export async function getExperimentStats({ tenantId = null, experimentId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.variant,
            COUNT(*)::int AS total_assignments,
            COUNT(r.id) FILTER (WHERE r.decision = 'accepted')::int AS accepted_count,
            COUNT(r.id) FILTER (WHERE r.decision = 'rejected')::int AS rejected_count,
            COUNT(r.id) FILTER (WHERE r.decision = 'needs_revision')::int AS revision_count,
            AVG(g.total_tokens)::int AS avg_tokens,
            AVG(g.latency_ms)::int AS avg_latency_ms,
            AVG(COALESCE(jsonb_array_length(g.safety_flags), 0))::numeric(6,2) AS avg_flags
     FROM clinical_ai_prompt_assignments a
     LEFT JOIN clinical_ai_generations g ON g.id = a.generation_id
     LEFT JOIN clinical_ai_reviews r ON r.generation_id = a.generation_id
     WHERE a.tenant_id = $1::uuid
       AND a.experiment_id = $2
     GROUP BY a.variant`,
    tid,
    Number.parseInt(experimentId, 10)
  );

  const stats = { A: null, B: null };
  for (const row of rows) {
    const total = Number(row.total_assignments || 0);
    const accepted = Number(row.accepted_count || 0);
    stats[row.variant] = {
      total_assignments: total,
      accepted_count: accepted,
      rejected_count: Number(row.rejected_count || 0),
      revision_count: Number(row.revision_count || 0),
      acceptance_rate_pct: total > 0 ? Math.round((accepted / total) * 100) : null,
      avg_tokens: row.avg_tokens ?? null,
      avg_latency_ms: row.avg_latency_ms ?? null,
      avg_flags: row.avg_flags ? Number(row.avg_flags) : 0,
    };
  }

  let winnerHint = null;
  if (stats.A && stats.B
      && stats.A.total_assignments >= 20 && stats.B.total_assignments >= 20
      && stats.A.acceptance_rate_pct != null && stats.B.acceptance_rate_pct != null) {
    const delta = stats.A.acceptance_rate_pct - stats.B.acceptance_rate_pct;
    if (delta >= 10) winnerHint = 'A';
    else if (delta <= -10) winnerHint = 'B';
  }

  return {
    variant_a: stats.A || { total_assignments: 0 },
    variant_b: stats.B || { total_assignments: 0 },
    winner_hint: winnerHint,
  };
}

export async function listExperiments({ tenantId = null, moduleKey = null, status = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, module_key, name, variant_a_prompt_id, variant_b_prompt_id,
            traffic_split_a, status, started_at, concluded_at, winning_variant,
            created_at, updated_at
     FROM clinical_ai_prompt_experiments
     WHERE tenant_id = $1::uuid
       AND ($2::text IS NULL OR module_key = $2)
       AND ($3::text IS NULL OR status = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    tid,
    moduleKey,
    status,
    safeLimit
  );
  return { experiments: rows, count: rows.length };
}

export default {
  concludeExperiment,
  createExperiment,
  getActiveExperimentForModule,
  getExperimentStats,
  listExperiments,
  pickVariant,
  recordAssignment,
};
