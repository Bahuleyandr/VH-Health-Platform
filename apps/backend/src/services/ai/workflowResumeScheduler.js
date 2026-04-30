/**
 * Auto-resume scheduler for paused workflow runs.
 *
 * Phase 5 of the clinical-AI rollout (docs/CLINICAL_AI_ROLLOUT_PLAN.md).
 *
 * Background loop that polls clinical_ai_workflow_runs.status='paused'
 * with pause_reason matching a known external-event reason (e.g.
 * 'await_governance'), checks whether the gating event has fired (e.g.
 * the matching clinical_ai_approvals row has flipped to 'approved'),
 * and calls resumeWorkflow() to advance the run.
 *
 * Scope (intentionally narrow):
 *   * Only the 'await_governance' pause reason is handled in this PR.
 *     Adding new external-event types is a small extension —
 *     register a new entry in HANDLERS below.
 *   * One run per tick (per-tenant). Avoids fan-out on a runaway
 *     governance approval queue. The cron runs every 30s, so even
 *     hundreds of pending resumes drain in under 5 minutes.
 *   * Only the discharge_summary_compose graph in this first cut —
 *     because that's the only workflow_key currently in production.
 *     Other graphs that adopt pauseRun() can register here.
 *
 * Failure semantics:
 *   * Resume failure leaves the run paused; the next tick retries.
 *     If the failure is permanent, an admin can mark the run
 *     status='failed' manually via the dashboard (see Phase 5+ task
 *     in the rollout plan — manual fail-paused-run UI not yet built;
 *     for now SQL UPDATE is the escape hatch).
 *
 * Cron entry lives in src/utils/scheduler.js — every 30s, with
 * withJobLock so a slow tick doesn't overlap.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { resumeWorkflow } from './workflowGraphRunner.js';
import { getDefaultCheckpointStore } from './workflowCheckpointStore.js';
import {
  getComposeGraph,
  DISCHARGE_COMPOSE_WORKFLOW_KEY,
} from './dischargeComposeService.js';

// Map workflow_key -> graph factory. When a paused run from one of
// these workflows passes its gate-check, resumeWorkflow is called with
// the graph from the registered factory. Other workflow keys are
// skipped — the scheduler can't resume a graph it doesn't know about.
const GRAPH_REGISTRY = new Map([
  [DISCHARGE_COMPOSE_WORKFLOW_KEY, getComposeGraph],
]);

// Map pause_reason -> async (run, store) => boolean. Returns true when
// the gate condition is satisfied and the run should be resumed.
//
// 'await_governance': checks for a clinical_ai_approvals row whose
// payload references the run's compose_generation_id and whose status
// has flipped to 'approved'. If multiple workflows ever use this same
// pause_reason, the handler must continue to differentiate them via
// the run's metadata.
const HANDLERS = new Map([
  ['await_governance', isGovernanceApproved],
]);

async function isGovernanceApproved(run) {
  const composeGenerationId =
    run.metadata?.pendingApproval?.compose_generation_id
    || run.state?.composeGeneration?.id
    || null;
  if (!composeGenerationId) {
    // No anchor we can match to an approvals row. Stay paused.
    return false;
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, decided_at
       FROM clinical_ai_approvals
       WHERE tenant_id = $1::uuid
         AND status = 'approved'
         AND payload @> jsonb_build_object('compose_generation_id', $2::int)
       ORDER BY decided_at DESC NULLS LAST
       LIMIT 1`,
      run.tenant_id,
      Number.parseInt(composeGenerationId, 10)
    );
    return Boolean(rows[0]);
  } catch (err) {
    logger.warn('workflowResumeScheduler: governance lookup failed', {
      runId: run.id,
      error: err.message,
    });
    return false;
  }
}

// ---------- main tick ---------------------------------------------------

/**
 * One pass of the scheduler. Iterates the paused-run rows, checks each
 * one's gate condition, and resumes those that have passed. Returns a
 * summary for logs + tests.
 *
 * Bounded by `maxResumes` to keep one tick under control. The cron
 * fires every 30s, so even a backlog of hundreds drains quickly.
 */
export async function runPausedWorkflowSweep({ maxResumes = 25 } = {}) {
  const startedAt = Date.now();
  const summary = {
    scanned: 0,
    skipped_unknown_workflow: 0,
    skipped_unknown_reason: 0,
    skipped_gate_not_satisfied: 0,
    resumed: 0,
    resume_failed: 0,
    duration_ms: 0,
  };

  let pausedRows;
  try {
    pausedRows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, workflow_key, pause_reason, current_node,
              metadata, state, started_at, paused_at
       FROM clinical_ai_workflow_runs
       WHERE status = 'paused'
       ORDER BY paused_at ASC NULLS LAST
       LIMIT $1`,
      maxResumes * 2 // pull a bit more so skips don't starve the loop
    );
  } catch (err) {
    if (/does not exist|relation .* does not exist/i.test(String(err?.message || ''))) {
      // Table missing — migration 109 not applied. Silently noop.
      return summary;
    }
    logger.error('workflowResumeScheduler: list paused failed', { error: err.message });
    summary.duration_ms = Date.now() - startedAt;
    return summary;
  }

  summary.scanned = pausedRows.length;
  const store = getDefaultCheckpointStore();

  for (const run of pausedRows) {
    if (summary.resumed >= maxResumes) break;

    const graphFactory = GRAPH_REGISTRY.get(run.workflow_key);
    if (!graphFactory) {
      summary.skipped_unknown_workflow += 1;
      continue;
    }

    const handler = HANDLERS.get(run.pause_reason);
    if (!handler) {
      summary.skipped_unknown_reason += 1;
      continue;
    }

    let gatePassed;
    try {
      gatePassed = await handler(run, store);
    } catch (err) {
      logger.warn('workflowResumeScheduler: gate handler threw', {
        runId: run.id,
        pauseReason: run.pause_reason,
        error: err.message,
      });
      gatePassed = false;
    }

    if (!gatePassed) {
      summary.skipped_gate_not_satisfied += 1;
      continue;
    }

    try {
      const outcome = await resumeWorkflow({
        runId: run.id,
        store,
        graph: graphFactory(),
      });
      logger.info('workflowResumeScheduler: resumed run', {
        runId: run.id,
        workflowKey: run.workflow_key,
        status: outcome.status,
      });
      if (outcome.status === 'failed') {
        summary.resume_failed += 1;
      } else {
        summary.resumed += 1;
      }
    } catch (err) {
      summary.resume_failed += 1;
      logger.error('workflowResumeScheduler: resumeWorkflow threw', {
        runId: run.id,
        error: err.message,
      });
    }
  }

  summary.duration_ms = Date.now() - startedAt;
  if (summary.resumed > 0 || summary.resume_failed > 0) {
    logger.info('workflowResumeScheduler tick', summary);
  }
  return summary;
}

// ---------- registration helpers (for future graph types) -------------

export function registerWorkflowGraph(workflowKey, graphFactory) {
  GRAPH_REGISTRY.set(workflowKey, graphFactory);
}

export function registerPauseReasonHandler(pauseReason, handler) {
  HANDLERS.set(pauseReason, handler);
}

// Test-only — lets the unit suite reset state between tests.
export const __testing__ = {
  GRAPH_REGISTRY,
  HANDLERS,
  isGovernanceApproved,
};

export default {
  runPausedWorkflowSweep,
  registerWorkflowGraph,
  registerPauseReasonHandler,
};
