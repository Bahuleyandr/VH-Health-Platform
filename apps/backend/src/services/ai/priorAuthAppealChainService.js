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
 * Task 4 (resume gates) will register this graph's pause reasons with the
 * scheduler so external events (human decision, payer webhook) trigger
 * resumeWorkflow. Do NOT register here.
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

export const WORKFLOW_KEY = 'prior_auth_appeal_chain';

// Multi-tenant helper — mirrors clinicalAiWorkflowService pattern.
function resolveTenantId(options = {}) {
  if (options.tenantId === null) return null;
  return options.tenantId || DEFAULT_TENANT_ID;
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
 * An external scheduler (Task 4) resumes this run when the decision is recorded.
 */
function await_human_disposition(state) {
  return pauseRun('await_appeal_human_disposition', {
    pendingDisposition: { appeal_id: state.appealId },
  });
}

/**
 * Park the run awaiting the payer's final verdict on the submitted appeal.
 * Resumed by a payer webhook handler (Task 4).
 */
function await_payer_response(state) {
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

// ---------- Public entry point -----------------------------------------

/**
 * Start a new prior-auth → appeal chain workflow run.
 *
 * Tenant resolution mirrors composeDischargePackage: reads `req.tenantId`
 * first (set by jwtMiddleware for tenant-scoped staff tokens), falls back
 * to DEFAULT_TENANT_ID via resolveTenantId.
 *
 * Returns:
 *   { status: 'paused', run_id, pause_reason }  — normal first-call outcome
 *   outcome.result                                — if chain completes synchronously (unlikely)
 * Throws AppError on validation failure or unrecoverable workflow failure.
 */
export async function composePriorAuthAppeal(priorAuthId, { startedBy = null, req = null } = {}) {
  if (!Number.isFinite(Number(priorAuthId))) {
    throw AppError.badRequest('Invalid prior_auth_id', 'INVALID_PRIOR_AUTH_ID');
  }

  // Mirror composeDischargePackage: resolve tenantId from req (set by jwtMiddleware)
  // then fall back to DEFAULT_TENANT_ID.
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });

  const outcome = await runWorkflow({
    graph: getPriorAuthAppealGraph(),
    initialState: {
      priorAuthId: Number(priorAuthId),
      tenantId,
    },
    ctx: { req },
    store: getDefaultCheckpointStore(),
    tenantId,
    startedBy,
    workflowMetadata: {
      prior_auth_id: priorAuthId,
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

// Test-only exports. The runtime exports above are the documented public API.
// Anything in __testing__ is implementation detail used by the unit suite only.
export const __testing__ = {
  NODES,
  WORKFLOW_KEY,
};

export default {
  composePriorAuthAppeal,
  getPriorAuthAppealGraph,
  WORKFLOW_KEY,
};
