import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getHealthReport } from '../../middleware/selfHealingMiddleware.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

/**
 * Collect findings across a handful of read-only signals. None of these
 * mutate state. The goal is to surface problems to admins as drafts, never
 * to auto-fix in production.
 */
async function collectFindings(tenantId) {
  const findings = [];

  // 1. Recent fallback spikes — if >10% of generations fell back to template
  //    in the past hour, flag it.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(CASE WHEN used_ai THEN 0 ELSE 1 END), 0)::int AS fallbacks
       FROM clinical_ai_generations
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - INTERVAL '1 hour'`,
      tenantId
    );
    const { total = 0, fallbacks = 0 } = rows[0] || {};
    if (total >= 10) {
      const pct = Math.round((fallbacks / total) * 100);
      if (pct >= 20) {
        findings.push({
          severity: pct >= 50 ? 'high' : 'medium',
          code: 'FALLBACK_SPIKE',
          message: `${pct}% of the last ${total} generations fell back to template`,
          suggested_action: 'Check provider health, verify API keys, confirm guardrails have not tripped.',
        });
      }
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Self-healing fallback check failed', { error: err.message });
    }
  }

  // 2. Stale pending reviews — if the oldest pending review is >72h, that
  //    means drafts are sitting in the queue without sign-off.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS stale_count, MIN(created_at) AS oldest
       FROM clinical_ai_reviews
       WHERE tenant_id = $1::uuid
         AND decision = 'pending'
         AND created_at < NOW() - INTERVAL '72 hours'`,
      tenantId
    );
    const { stale_count = 0, oldest = null } = rows[0] || {};
    if (stale_count > 0) {
      findings.push({
        severity: 'medium',
        code: 'STALE_REVIEWS',
        message: `${stale_count} reviews pending >72h (oldest: ${oldest || 'unknown'})`,
        suggested_action: 'Notify review-role owners or re-assign to on-call reviewer.',
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Self-healing stale-reviews check failed', { error: err.message });
    }
  }

  // 3. Active break-glass past its halfway point — a soft reminder for admins.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, scope, reason, expires_at
       FROM clinical_ai_break_glass_sessions
       WHERE tenant_id = $1::uuid
         AND status = 'active'
         AND expires_at > NOW()
       ORDER BY expires_at DESC
       LIMIT 5`,
      tenantId
    );
    for (const row of rows) {
      findings.push({
        severity: 'medium',
        code: 'BREAK_GLASS_ACTIVE',
        message: `Break-glass session ${row.id} active until ${row.expires_at}`,
        suggested_action: 'Confirm scope is still justified or end the session.',
        metadata: { session_id: row.id, scope: row.scope, reason: row.reason },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Self-healing break-glass check failed', { error: err.message });
    }
  }

  // 4. Process-level health signal from the existing middleware.
  try {
    const health = getHealthReport();
    if (health?.status && health.status !== 'ok') {
      findings.push({
        severity: 'high',
        code: 'PROCESS_HEALTH',
        message: `Self-healing middleware reported status: ${health.status}`,
        suggested_action: 'Inspect process logs and DB pool stats. Restart only after confirming root cause.',
        metadata: health,
      });
    }
  } catch (err) {
    logger.warn('Self-healing process-health snapshot failed', { error: err.message });
  }

  return findings;
}

function derivedActions(findings) {
  // De-duplicated "what to do next" list — one bullet per unique suggestion
  // so the admin UI can render a single action column.
  const seen = new Set();
  return findings
    .map((finding) => finding.suggested_action)
    .filter((action) => {
      if (!action || seen.has(action)) return false;
      seen.add(action);
      return true;
    })
    .map((action) => ({ action }));
}

export async function runSelfHealingScan(options = {}) {
  const tenantId = resolveTenantId(options);
  const scope = String(options.scope || 'routine').slice(0, 40);
  const startedBy = options.startedBy || null;

  let runId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_self_healing_runs
         (tenant_id, started_by, scope, status, metadata, started_at)
       VALUES ($1::uuid, $2::uuid, $3, 'running', $4::jsonb, NOW())
       RETURNING id, started_at`,
      tenantId,
      startedBy,
      scope,
      JSON.stringify({ triggered_via: options.triggeredVia || 'manual' })
    );
    runId = rows[0].id;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Self-healing run row creation failed', { error: err.message });
    }
  }

  const findings = await collectFindings(tenantId);
  const suggested = derivedActions(findings);

  try {
    if (runId) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_self_healing_runs
         SET status = 'completed',
             findings = $2::jsonb,
             suggested_actions = $3::jsonb,
             finished_at = NOW()
         WHERE id = $1`,
        runId,
        JSON.stringify(findings),
        JSON.stringify(suggested)
      );
    }
  } catch (err) {
    logger.warn('Self-healing run finalize failed', { runId, error: err.message });
  }

  return {
    run_id: runId,
    tenant_id: tenantId,
    started_at: new Date().toISOString(),
    findings,
    suggested_actions: suggested,
    // Signal that this run is informational only — admins still have to act.
    read_only: true,
  };
}

export async function listSelfHealingRuns({ tenantId = null, limit = 20 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, started_by, started_at, finished_at, status, scope,
              findings, suggested_actions, metadata
       FROM clinical_ai_self_healing_runs
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

export default {
  listSelfHealingRuns,
  runSelfHealingScan,
};
