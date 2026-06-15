/**
 * Prior-auth → appeal chain workflow.
 *
 * Orchestrates a resumable two-pause workflow that:
 *   1. Loads a denied prior-auth request and validates it is eligible.
 *   2. Classifies the payer denial reason.
 *   3. Drafts an appeal letter via generateAppealLetter (LLM + template fallback).
 *   4. Parks the run awaiting a human disposition decision (accept/edit/reject).
 *   5. After disposition, parks again awaiting the payer's response.
 *   6. Finalizes the outcome: persists appeal status and publishes a domain event.
 *
 * Pattern mirrors dischargeComposeService.js — linear node list, singleton
 * process graph, compose entry point with outcome mapping.
 *
 * The two pause nodes are resume-aware: on re-entry they check whether the
 * awaited condition already holds (isAppealSubmitted / isAppealResolved) and
 * proceed immediately if so. This prevents infinite re-pausing.
 *
 * Gate predicates (gateSubmitted / gateResolved) share the same predicate
 * functions and are registered with workflowResumeScheduler at module load
 * so the scheduler can trigger resumeWorkflow when external events fire.
 */

import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { classifyDenialReason, generateAppealLetter } from './appealLetterGeneratorService.js';
import { WorkflowGraph, runWorkflow, pauseRun } from './workflowGraphRunner.js';
import { getDefaultCheckpointStore } from './workflowCheckpointStore.js';
import {
  registerWorkflowGraph,
  registerPauseReasonHandler,
} from './workflowResumeScheduler.js';

export const WORKFLOW_KEY = 'prior_auth_appeal_chain';

// ---------- Shared gate predicates ------------------------------------
// Single source of truth used by BOTH the resume-aware pause nodes
// and the scheduler gate functions (gateSubmitted / gateResolved).
// Both return false on any error / missing row so first-run pauses
// safely and the scheduler never throws.

async function isAppealSubmitted({ appealId, tenantId }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT appeal_status FROM clinical_ai_appeal_letters WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      Number(appealId), tenantId);
    return rows?.[0]?.appeal_status === 'submitted';
  } catch (err) {
    logger.warn('isAppealSubmitted lookup failed', { appealId, error: err.message });
    return false;
  }
}

async function isAppealResolved({ appealId, tenantId }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT appeal_status FROM clinical_ai_appeal_letters WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      Number(appealId), tenantId);
    return ['approved', 'denied', 'withdrawn'].includes(rows?.[0]?.appeal_status);
  } catch (err) {
    logger.warn('isAppealResolved lookup failed', { appealId, error: err.message });
    return false;
  }
}

// ---------- Graph nodes (declared in linear execution order) -----------

/**
 * Load and validate the denied prior-auth request.
 * Checks that it exists, belongs to the tenant, is in 'denied' status,
 * and that the appeal_letter_generator module is enabled for the tenant.
 */
async function load_denied_prior_auth(state, _ctx) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, status, payer_decision_reason, patient_uid
       FROM clinical_ai_prior_auth_requests
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    Number(state.priorAuthId),
    state.tenantId
  );
  if (!rows || rows.length === 0) {
    throw AppError.notFound(
      `Prior auth request ${state.priorAuthId} not found`,
      'PRIOR_AUTH_NOT_FOUND'
    );
  }
  const priorAuth = rows[0];
  if (priorAuth.status !== 'denied') {
    throw AppError.badRequest(
      `Prior auth request ${state.priorAuthId} is not in denied status (actual: ${priorAuth.status})`,
      'PRIOR_AUTH_NOT_DENIED'
    );
  }
  const module = await getClinicalAiModule('appeal_letter_generator', { tenantId: state.tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(
      'Clinical AI module is disabled: appeal_letter_generator',
      'APPEAL_MODULE_DISABLED'
    );
  }
  return {
    priorAuth,
    module,
    denialReason: priorAuth.payer_decision_reason || '',
  };
}

/**
 * Classify the payer's denial reason into a structured category.
 * Pure function — no I/O, no side effects.
 */
function classify_denial(state) {
  return {
    classification: classifyDenialReason({ denialReason: state.denialReason }),
  };
}

/**
 * Draft the appeal letter via LLM + template fallback.
 * Persists clinical_ai_appeal_letters + clinical_ai_generations + clinical_ai_reviews.
 * Returns the appeal record's id under `appealId` so downstream nodes can reference it.
 */
async function draft_appeal(state, ctx) {
  const appeal = await generateAppealLetter({
    req: ctx.req,
    priorAuthId: state.priorAuth.id,
  });
  return {
    appeal,
    appealId: appeal.appeal_id,
  };
}

/**
 * Park the run awaiting a human decision on the drafted appeal
 * (accept → move to payer submission, edit, or reject/withdraw).
 *
 * Resume-aware: on re-entry (the runner lands back on this node after a
 * resumeWorkflow call) we check whether the appeal has been submitted.
 * If yes, return {} to proceed; otherwise re-pause. The scheduler only
 * resumes when gateSubmitted() returns true, so on resume the condition
 * is always satisfied — this guard is purely a correctness safety net.
 */
async function await_human_disposition(state) {
  if (await isAppealSubmitted({ appealId: state.appealId, tenantId: state.tenantId })) return {};
  return pauseRun('await_appeal_human_disposition', {
    pendingDisposition: { appeal_id: state.appealId },
  });
}

/**
 * Park the run awaiting the payer's final verdict on the submitted appeal.
 * Resumed by a payer webhook handler registered with the scheduler.
 *
 * Resume-aware: on re-entry checks isAppealResolved; proceeds if true,
 * re-pauses otherwise (same correctness rationale as await_human_disposition).
 */
async function await_payer_response(state) {
  if (await isAppealResolved({ appealId: state.appealId, tenantId: state.tenantId })) return {};
  return pauseRun('await_appeal_payer_response', {
    pendingPayerResponse: { appeal_id: state.appealId },
  });
}

/**
 * Read the final appeal status from the DB, publish a domain event (best-effort),
 * and return the workflow result.
 */
async function finalize_outcome(state, _ctx) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT appeal_status FROM clinical_ai_appeal_letters WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    Number(state.appealId),
    state.tenantId
  );
  const outcome = rows?.[0]?.appeal_status || 'unknown';

  try {
    await publishEvent({
      eventType: 'clinical_ai.prior_auth_appeal_resolved',
      aggregateType: 'prior_auth',
      aggregateId: String(state.priorAuth.id),
      patientUid: state.priorAuth.patient_uid,
      payload: {
        appeal_id: state.appealId,
        outcome,
      },
    });
  } catch (err) {
    // Best-effort — do not fail the workflow if the event bus is down.
    logger.warn('Failed to publish prior_auth_appeal_resolved event', {
      priorAuthId: state.priorAuth.id,
      appealId: state.appealId,
      error: err.message,
    });
  }

  return {
    result: {
      prior_auth_id: state.priorAuth.id,
      appeal_id: state.appealId,
      outcome,
    },
  };
}

// Exported as a named object so the test can import NODES directly.
export const NODES = {
  load_denied_prior_auth,
  classify_denial,
  draft_appeal,
  await_human_disposition,
  await_payer_response,
  finalize_outcome,
};

// ---------- Graph singleton --------------------------------------------

let _graph = null;
/**
 * Returns the (lazily-built) WorkflowGraph for prior_auth_appeal_chain.
 * Process singleton — safe to call multiple times.
 */
export function getPriorAuthAppealGraph() {
  if (!_graph) {
    _graph = new WorkflowGraph({
      key: WORKFLOW_KEY,
      nodes: NODES,
      start: 'load_denied_prior_auth',
    });
  }
  return _graph;
}

// ---------- Scheduler gate predicates ----------------------------------
// Called by the resume scheduler to decide whether a paused run is ready
// to be continued. Both read the appeal id from run.state first, then
// fall back to run.metadata (for legacy persisted runs).

async function gateSubmitted(run) {
  const appealId =
    run?.state?.pendingDisposition?.appeal_id ??
    run?.metadata?.pendingDisposition?.appeal_id;
  if (!appealId) return false;
  return isAppealSubmitted({ appealId, tenantId: run.tenant_id });
}

async function gateResolved(run) {
  const appealId =
    run?.state?.pendingPayerResponse?.appeal_id ??
    run?.metadata?.pendingPayerResponse?.appeal_id;
  if (!appealId) return false;
  return isAppealResolved({ appealId, tenantId: run.tenant_id });
}

// ---------- Scheduler registration (module-load side effect) -----------
// Registers this graph and its pause-reason gates so the resume scheduler
// can resume runs without knowing the internals of this workflow.
registerWorkflowGraph(WORKFLOW_KEY, getPriorAuthAppealGraph);
registerPauseReasonHandler('await_appeal_human_disposition', gateSubmitted);
registerPauseReasonHandler('await_appeal_payer_response', gateResolved);

// ---------- Public entry point -----------------------------------------

/**
 * Start a new prior-auth → appeal chain workflow run.
 *
 * Tenant resolution mirrors composeDischargePackage: reads `req.tenantId`
 * first (set by jwtMiddleware for tenant-scoped staff tokens), falls back
 * to DEFAULT_TENANT_ID.
 *
 * Returns:
 *   { status: 'paused', run_id, pause_reason }  — normal first-call outcome
 *   outcome.result                                — if chain completes synchronously (unlikely)
 * Throws AppError on validation failure or unrecoverable workflow failure.
 */
export async function composePriorAuthAppeal(priorAuthId, { startedBy = null, req = null, tenantId = undefined } = {}) {
  if (!Number.isFinite(Number(priorAuthId))) {
    throw AppError.badRequest('Invalid prior_auth_id', 'INVALID_PRIOR_AUTH_ID');
  }

  // Explicit tenantId wins, then req.tenantId, then DEFAULT_TENANT_ID.
  // This lets the scheduler sweep pass each PA's own tenant without a req.
  const resolvedTenantId = tenantId ?? req?.tenantId ?? DEFAULT_TENANT_ID;

  const outcome = await runWorkflow({
    graph: getPriorAuthAppealGraph(),
    initialState: {
      priorAuthId: Number(priorAuthId),
      tenantId: resolvedTenantId,
    },
    ctx: { req },
    store: getDefaultCheckpointStore(),
    tenantId: resolvedTenantId,
    startedBy,
    workflowMetadata: {
      prior_auth_id: Number(priorAuthId),
    },
  });

  if (outcome.status === 'failed') {
    const node = outcome.error?.node || 'unknown';
    const message = outcome.error?.message || 'Workflow failed';
    logger.error('Prior-auth appeal chain workflow failed', { priorAuthId, node, message });
    throw AppError.internal('Failed to run prior-auth appeal chain', 'PRIOR_AUTH_APPEAL_CHAIN_FAILED');
  }

  if (outcome.status === 'paused') {
    return {
      status: 'paused',
      run_id: outcome.runId,
      pause_reason: outcome.pauseReason,
    };
  }

  return outcome.result;
}

// ---------- Scheduler sweep ---------------------------------------------------

/**
 * Cross-tenant sweep that finds denied prior-auth requests which have no
 * appeal letter and no workflow run yet, and auto-starts the appeal chain
 * for each.  Intended to be called from the scheduler (no HTTP request
 * context); each PA's own tenant is resolved and passed explicitly so
 * composePriorAuthAppeal can apply the correct RLS / module gate.
 *
 * Idempotent: the NOT EXISTS guards avoid redundant starts; the hard
 * backstop is the partial-unique index `uq_appeal_prior_auth` on the
 * appeal table (a duplicate draft INSERT fails).
 *
 * @param {{ maxStarts?: number }} opts
 * @returns {Promise<{ scanned: number, started: number, skipped_disabled: number, failed: number }>}
 */
export async function startPendingPriorAuthAppeals({ maxStarts = 25 } = {}) {
  const summary = { scanned: 0, started: 0, skipped_disabled: 0, failed: 0 };
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT pa.id, pa.tenant_id
         FROM clinical_ai_prior_auth_requests pa
        WHERE pa.status = 'denied'
          AND NOT EXISTS (SELECT 1 FROM clinical_ai_appeal_letters a WHERE a.prior_auth_id = pa.id)
          AND NOT EXISTS (
            SELECT 1 FROM clinical_ai_workflow_runs r
             WHERE r.workflow_key = 'prior_auth_appeal_chain'
               AND r.metadata->>'prior_auth_id' = pa.id::text)
        ORDER BY pa.payer_decided_at ASC NULLS LAST
        LIMIT $1::int`,
      Number(maxStarts));
  } catch (err) {
    logger.warn('startPendingPriorAuthAppeals scan failed', { error: err.message });
    return summary; // missing table / DB down → no-op
  }
  for (const pa of rows || []) {
    summary.scanned += 1;
    try {
      // Only start when the appeal module is enabled for THIS PA's tenant.
      const module = await getClinicalAiModule('appeal_letter_generator', { tenantId: pa.tenant_id });
      if (!module.enabled) { summary.skipped_disabled += 1; continue; }
      await composePriorAuthAppeal(pa.id, { startedBy: null, tenantId: pa.tenant_id });
      summary.started += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn('startPendingPriorAuthAppeals: failed to start chain for PA', { priorAuthId: pa.id, error: err.message });
    }
  }
  return summary;
}

// Test-only exports. The runtime exports above are the documented public API.
// Anything in __testing__ is implementation detail used by the unit suite only.
export const __testing__ = {
  NODES,
  WORKFLOW_KEY,
  gateSubmitted,
  gateResolved,
  isAppealSubmitted,
  isAppealResolved,
};

export default {
  composePriorAuthAppeal,
  getPriorAuthAppealGraph,
  WORKFLOW_KEY,
};
