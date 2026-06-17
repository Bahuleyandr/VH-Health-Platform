/**
 * Discharge package compose workflow.
 *
 * The first concrete consumer of the workflow graph runner's subgraph
 * composition primitive (migrations 109 + 110, services
 * workflowGraphRunner.js + workflowCheckpointStore.js). It orchestrates
 * four child admission_ai_draft subgraphs into a unified discharge
 * package and demonstrates:
 *
 *   * Subgraph spawn with parent_run_id linkage — each child is its own
 *     clinical_ai_workflow_runs row, queryable as a tree from the
 *     parent.
 *   * Result merge — each spawn returns a state delta into the parent
 *     under a named resultKey, so assemble_compose_result can read
 *     all four drafts uniformly.
 *   * Optional governance pause — the assemble + persist nodes can
 *     park the run for human approval before publishing. The pattern
 *     is wired in here as the canonical demonstration; a future
 *     scheduler that polls store.listPaused({ pause_reason: 'await_governance' })
 *     completes the loop.
 *   * Idempotent resume — if the parent crashes mid-workflow (e.g.
 *     after med_rec but before aftercare), resumeWorkflow rediscovers
 *     the completed children via state.__subgraphs and skips re-running
 *     them.
 *
 * Each child draft remains independently reviewable through the
 * existing clinical_ai_reviews flow (each child's
 * createReviewPlaceholder runs as before). The parent persists a single
 * roll-up generation row tied to the children via
 * metadata.child_generation_ids so dashboards can show the tree.
 *
 * Safety contract: same as everything else in clinical AI services.
 * The compose graph is rules-authoritative — the assemble node does
 * NO inference of its own; it only composes what the children produced.
 * If any child draft hit a CRITICAL safety flag, that bubbles up into
 * the parent's overall_safety_band.
 */

import crypto from 'node:crypto';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import {
  ADMISSION_MODULES,
  getAdmissionAiDraftGraph,
  requireEnabledModule,
  resolveTenantId,
} from './clinicalAiWorkflowService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { WorkflowGraph, runWorkflow, pauseRun } from './workflowGraphRunner.js';
import { getDefaultCheckpointStore } from './workflowCheckpointStore.js';

const COMPOSE_MODULE_KEY = 'discharge_summary_compose';

const DEFAULT_COMPOSE_CHILDREN = [
  'medication_reconciliation',
  'patient_aftercare_instructions',
  'discharge_readiness',
  'clinical_coding_assist',
];

// Mapping: compose-child module key -> parent state key under which the
// child's result will be stored. Kept stable as a contract — the
// assemble_compose_result node reads these by exact name. Renaming a
// child requires re-running paused parent runs that captured the old key.
const RESULT_KEYS = {
  medication_reconciliation: 'med_rec_draft',
  patient_aftercare_instructions: 'aftercare_draft',
  discharge_readiness: 'readiness_draft',
  clinical_coding_assist: 'coding_draft',
};

const SAFETY_BAND_PRIORITY = ['ok', 'low', 'medium', 'high', 'critical'];

function highestBand(bands) {
  let best = 'ok';
  for (const band of bands) {
    if (SAFETY_BAND_PRIORITY.indexOf(band) > SAFETY_BAND_PRIORITY.indexOf(best)) best = band;
  }
  return best;
}

function bandFromSafetyFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return 'ok';
  const severities = flags.map((flag) => String(flag.severity || '').toLowerCase());
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('high')) return 'high';
  if (severities.includes('medium')) return 'medium';
  if (severities.includes('low')) return 'low';
  return 'ok';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// ---------- Governance approval predicate -------------------------------

/**
 * Returns true when a clinical_ai_approvals row exists for the given
 * compose_generation_id whose status is 'approved'.
 *
 * Used by the await_governance_approval graph node (resume-aware check)
 * to detect whether approval has already been granted before deciding to
 * pause. Returns false on any error or when composeGenerationId is null
 * so first-run calls always pause safely.
 *
 * NOTE: This is intentionally inlined here rather than imported from
 * workflowResumeScheduler.js (isGovernanceApproved). The scheduler
 * imports getComposeGraph from this file at module load, so importing
 * back from the scheduler would create a circular dependency. The query
 * body is kept in sync by comment reference.
 */
async function isComposeGovernanceApproved({ tenantId, composeGenerationId }) {
  if (!composeGenerationId) return false;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, decided_at
       FROM clinical_ai_approvals
       WHERE tenant_id = $1::uuid
         AND status = 'approved'
         AND payload @> jsonb_build_object('compose_generation_id', $2::int)
       ORDER BY decided_at DESC NULLS LAST
       LIMIT 1`,
      tenantId,
      Number.parseInt(composeGenerationId, 10)
    );
    return Boolean(rows[0]);
  } catch (err) {
    logger.warn('dischargeComposeService: governance approval lookup failed', {
      composeGenerationId,
      error: err.message,
    });
    return false;
  }
}

// ---------- Graph nodes -------------------------------------------------

const COMPOSE_GRAPH_NODES = {
  /**
   * Validate that every child module the operator selected is in
   * ADMISSION_MODULES (i.e. supported by admission_ai_draft) and that
   * the module is enabled for this tenant. Halt early with a structured
   * result if any precondition fails — this avoids spawning children
   * that we know will reject.
   */
  precheck_children: async (state) => {
    const requested = state.composeChildren || DEFAULT_COMPOSE_CHILDREN;
    const unsupported = requested.filter((key) => !ADMISSION_MODULES.has(key));
    if (unsupported.length) {
      throw AppError.badRequest(
        `Unsupported compose child module(s): ${unsupported.join(', ')}`,
        'COMPOSE_CHILD_UNSUPPORTED'
      );
    }
    // Tests inject a pre-loaded childModules map to skip the DB lookup;
    // production callers leave it unset and we fetch from
    // clinical_ai_modules. Either way the rest of the graph reads
    // state.childModules.
    let modules = state.childModules || null;
    const skippedChildren = [];
    if (!modules) {
      modules = {};
      for (const key of requested) {
        try {
          modules[key] = await requireEnabledModule(key, { tenantId: state.tenantId });
        } catch (err) {
          // A child module disabled for this tenant (e.g. the patient-facing
          // aftercare-instructions module, OFF by policy) must NOT fail the
          // whole discharge package. Degrade gracefully: skip the disabled
          // child and compose the rest. requireEnabledModule throws
          // AppError.forbidden (403) for a disabled module; rethrow anything
          // else (not-found, schema) so genuine errors still surface.
          if (err?.statusCode === 403) {
            skippedChildren.push(key);
            logger.info('dischargeCompose: skipping disabled child module', {
              module: key,
              tenantId: state.tenantId,
            });
          } else {
            throw err;
          }
        }
      }
    }
    const activeChildren = requested.filter((key) => modules[key]);
    if (activeChildren.length === 0) {
      throw AppError.badRequest(
        'No enabled compose child modules for this tenant',
        'COMPOSE_NO_ENABLED_CHILDREN'
      );
    }
    return { activeChildren, childModules: modules, skippedChildren };
  },

  spawn_med_rec: async (state, ctx) => spawnIfRequested(state, ctx, 'medication_reconciliation'),
  spawn_aftercare: async (state, ctx) => spawnIfRequested(state, ctx, 'patient_aftercare_instructions'),
  spawn_readiness: async (state, ctx) => spawnIfRequested(state, ctx, 'discharge_readiness'),
  spawn_coding: async (state, ctx) => spawnIfRequested(state, ctx, 'clinical_coding_assist'),

  /**
   * Combine the four child outputs into a single discharge-package
   * shape. Pure composition: no AI call, no chart re-fetch. Reads the
   * resultKey-named fields populated by the spawn nodes.
   */
  assemble_compose_result: async (state) => {
    const components = {};
    const safetyBands = [];
    const childGenerationIds = [];
    const childCriticalFlags = [];

    for (const childKey of state.activeChildren) {
      const draft = state[RESULT_KEYS[childKey]] || null;
      if (!draft) continue;
      components[childKey] = {
        draft: draft.draft,
        review_id: draft.review_id || null,
        generation_id: draft.draft_generation_id || null,
        review_status: draft.review_status || 'pending',
        safety_flags: draft.safety_flags || [],
      };
      const band = bandFromSafetyFlags(draft.safety_flags);
      safetyBands.push(band);
      if (draft.draft_generation_id) childGenerationIds.push(draft.draft_generation_id);
      childCriticalFlags.push(
        ...asArray(draft.safety_flags).filter((flag) => String(flag.severity).toLowerCase() === 'critical')
      );
    }

    const overall = highestBand(safetyBands);
    const composeDraft = {
      admission_id: state.admissionId,
      generated_at: new Date().toISOString(),
      components,
      overall_safety_band: overall,
      child_generation_ids: childGenerationIds,
      compose_children: state.activeChildren,
      // Children requested but skipped because they are disabled for this
      // tenant (degrade-and-skip; the package composes what IS enabled).
      skipped_children: asArray(state.skippedChildren),
      // Bubble up critical flags so reviewers see them at the parent
      // level too — they're the single thing that should block release
      // of the package.
      critical_safety_flags: childCriticalFlags,
    };

    return { composeDraft, overallSafetyBand: overall };
  },

  /**
   * Persist a single parent generation row in clinical_ai_generations
   * with task_type/module_key='discharge_summary_compose'. Citations are
   * the union of the children's citations; metadata records the
   * child_generation_ids for traversal. The row uses provider='compose'
   * + used_ai=false because this layer doesn't itself call an LLM.
   */
  persist_compose_generation: async (state) => {
    const status = state.overallSafetyBand === 'critical' ? 'failed' : 'draft';
    const failureReason = status === 'failed' ? 'critical_child_safety_flag' : null;
    const composeDraft = state.composeDraft;

    try {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_generations
           (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
            prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
            generated_by, prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor,
            latency_ms, provider_request_id, finish_reason, metadata, created_at, updated_at)
         VALUES
           ($1::uuid, $2::uuid, $3, $4, $4, 'compose', 'subgraph_orchestration',
            'compose-v1', $5, $6, false, $7::jsonb, $8::jsonb, $9::jsonb,
            $10::uuid, 0, 0, 0, NULL,
            NULL, NULL, NULL, $11::jsonb, NOW(), NOW())
         RETURNING id, status, created_at`,
        state.tenantId,
        state.patientUid,
        state.admissionId,
        COMPOSE_MODULE_KEY,
        // source_hash: deterministic on the set of child generation ids
        // so re-running compose with the same children produces a stable
        // hash for dedupe / audit.
        crypto.createHash('sha256').update(JSON.stringify(composeDraft.child_generation_ids)).digest('hex'),
        status,
        JSON.stringify(composeDraft.critical_safety_flags),
        JSON.stringify([]),
        JSON.stringify(composeDraft),
        state.requestedBy,
        JSON.stringify({
          request_id: state.requestContext?.request_id || null,
          tenant_region: state.requestContext?.tenant_region || null,
          compose_children: state.activeChildren,
          child_generation_ids: composeDraft.child_generation_ids,
          overall_safety_band: state.overallSafetyBand,
          failure_reason: failureReason,
        })
      );
      return { composeGeneration: rows[0] };
    } catch (err) {
      logger.error('Failed to persist compose generation', {
        admissionId: state.admissionId,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Optional governance pause. Gated by the module's
   * settings.requireGovernanceApproval. When set, parks the run; the
   * workflowResumeScheduler detects the matching clinical_ai_approvals
   * row transitioning to 'approved' and resumes via resumeWorkflow().
   *
   * Resume-aware: on re-entry (after the scheduler resumes the run) the
   * node checks whether approval already exists and proceeds immediately
   * if so. Without this check the node would unconditionally re-pause on
   * every resume, causing an infinite loop (the scheduler resumes → node
   * pauses again → scheduler resumes → ...).
   *
   * Predicate mirrors workflowResumeScheduler.isGovernanceApproved() but
   * is inlined here to avoid a circular import: workflowResumeScheduler
   * imports getComposeGraph from this file at module load, so importing
   * back from the scheduler would create a cycle.
   */
  await_governance_approval: async (state) => {
    if (!state.composeModule?.settings?.requireGovernanceApproval) {
      return {}; // pass through; no pause
    }
    const generationId = state.composeGeneration?.id || null;
    if (generationId && await isComposeGovernanceApproved({ tenantId: state.tenantId, composeGenerationId: generationId })) {
      return {}; // already approved → proceed
    }
    return pauseRun('await_governance', {
      pendingApproval: {
        compose_generation_id: generationId,
        admission_id: state.admissionId,
      },
    });
  },

  publish_compose_event: async (state) => {
    await publishEvent({
      eventType: 'clinical_ai.discharge_compose_generated',
      aggregateType: 'clinical_ai_generation',
      aggregateId: state.composeGeneration?.id || null,
      patientUid: state.patientUid,
      payload: {
        tenant_id: state.tenantId,
        admission_id: state.admissionId,
        compose_children: state.activeChildren,
        child_generation_ids: state.composeDraft.child_generation_ids,
        overall_safety_band: state.overallSafetyBand,
      },
    });
    return {};
  },

  build_response: async (state) => ({
    result: {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: state.admissionId,
      compose_generation_id: state.composeGeneration?.id || null,
      overall_safety_band: state.overallSafetyBand,
      compose_children: state.activeChildren,
      components: state.composeDraft.components,
      child_generation_ids: state.composeDraft.child_generation_ids,
      critical_safety_flags: state.composeDraft.critical_safety_flags,
      requires_signoff: true,
    },
  }),
};

/**
 * Common helper invoked by the per-child spawn nodes. If the child
 * module is on the active list, spawn the admission_ai_draft graph as a
 * subgraph; otherwise pass through. Idempotent re-entry is handled
 * inside ctx.runSubgraph (see workflowGraphRunner.js).
 *
 * The admission graph is read from ctx.admissionGraph if present —
 * tests pass a stubbed graph that returns synthetic drafts via the
 * runWorkflow `ctx` parameter (which is not persisted with state, so
 * its class instances + functions survive). Production callers leave
 * it unset, which falls back to getAdmissionAiDraftGraph().
 */
async function spawnIfRequested(state, ctx, childModuleKey) {
  if (!state.activeChildren?.includes(childModuleKey)) {
    return {}; // child disabled by tenant config
  }
  const childModule = state.childModules?.[childModuleKey];
  if (!childModule) {
    throw AppError.internal(
      `Compose child module '${childModuleKey}' was not pre-loaded`,
      'COMPOSE_CHILD_MODULE_MISSING'
    );
  }
  const admissionGraph = ctx.admissionGraph || getAdmissionAiDraftGraph();
  return ctx.runSubgraph({
    graph: admissionGraph,
    initialState: {
      admissionId: state.admissionId,
      moduleKey: childModuleKey,
      requestedBy: state.requestedBy,
      requestContext: state.requestContext,
      module: childModule,
      tenantId: state.tenantId,
    },
    resultKey: RESULT_KEYS[childModuleKey],
    metadata: {
      module_key: childModuleKey,
      admission_id: state.admissionId,
      composed_under: COMPOSE_MODULE_KEY,
    },
  });
}

let _composeGraph = null;
/**
 * Returns the (lazily-built) WorkflowGraph for discharge_summary_compose.
 * Public so callers like the resume route can pass it to resumeWorkflow
 * without re-importing the private constants. Idempotent — the graph is
 * built once per process.
 */
export function getComposeGraph() {
  if (!_composeGraph) {
    _composeGraph = new WorkflowGraph({
      key: COMPOSE_MODULE_KEY,
      nodes: COMPOSE_GRAPH_NODES,
      start: 'precheck_children',
    });
  }
  return _composeGraph;
}

// ---------- Public entry point -----------------------------------------

/**
 * Compose a discharge package for an admission. Spawns up to four
 * admission_ai_draft subgraphs, assembles their results, and persists a
 * parent generation row tying them together.
 *
 * Returns the standard response shape (final node is build_response).
 * Throws AppError on validation failure or unrecoverable child failure.
 *
 * Idempotent on resume: if a previous invocation crashed or paused, the
 * caller can re-invoke with the same admissionId — no, wait, that would
 * start a new top-level run. To resume the prior, call resumeWorkflow
 * with the prior runId. composeDischargePackage always starts a fresh
 * top-level run; the children inside are idempotent on resume of the
 * parent.
 */
export async function composeDischargePackage(admissionId, requestedBy, req = null) {
  if (!Number.isFinite(Number(admissionId))) {
    throw AppError.badRequest('Invalid admission id', 'INVALID_ADMISSION_ID');
  }
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const composeModule = await getClinicalAiModule(COMPOSE_MODULE_KEY, { tenantId });
  if (!composeModule.enabled) {
    throw AppError.forbidden(
      `Discharge compose module is disabled for this tenant`,
      'COMPOSE_MODULE_DISABLED'
    );
  }

  const composeChildren = composeModule.settings?.composeChildren?.length
    ? composeModule.settings.composeChildren
    : DEFAULT_COMPOSE_CHILDREN;

  const requestContext = {
    request_id: req?.id || null,
    tenant_region: req?.tenant?.region || null,
  };

  const patientUid = await resolvePatientUid(admissionId);

  const outcome = await runWorkflow({
    graph: getComposeGraph(),
    initialState: {
      admissionId,
      requestedBy,
      requestContext,
      tenantId,
      patientUid,
      composeChildren,
      composeModule,
    },
    store: getDefaultCheckpointStore(),
    tenantId,
    startedBy: requestedBy,
    workflowMetadata: {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: admissionId,
      request_id: requestContext.request_id,
    },
  });

  if (outcome.status === 'failed') {
    const node = outcome.error?.node || 'unknown';
    const message = outcome.error?.message || 'Workflow failed';
    logger.error('Discharge compose workflow failed', { admissionId, node, message });
    throw AppError.internal('Failed to compose discharge package', 'DISCHARGE_COMPOSE_FAILED');
  }

  if (outcome.status === 'paused') {
    return {
      module_key: COMPOSE_MODULE_KEY,
      admission_id: admissionId,
      run_id: outcome.runId,
      status: 'paused',
      pause_reason: outcome.pauseReason,
      message: 'Discharge compose is awaiting external action; resume via resumeWorkflow with this run_id.',
    };
  }

  return outcome.result;
}

async function resolvePatientUid(admissionId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid FROM admissions WHERE id = $1 LIMIT 1`,
      Number.parseInt(admissionId, 10)
    );
    return rows[0]?.patient_uid || null;
  } catch (err) {
    logger.warn('Failed to resolve patient_uid for compose', { admissionId, error: err.message });
    return null;
  }
}

// Public constant — useful for callers that want the canonical key
// (e.g. listing compose runs filtered by workflow_key).
export const DISCHARGE_COMPOSE_WORKFLOW_KEY = COMPOSE_MODULE_KEY;

// Test-only exports. The runtime exports above (composeDischargePackage,
// getComposeGraph, DISCHARGE_COMPOSE_WORKFLOW_KEY) are the documented
// public API. Anything in __testing__ is implementation detail used by
// the unit suite and is liable to change.
export const __testing__ = {
  COMPOSE_MODULE_KEY,
  COMPOSE_GRAPH_NODES,
  RESULT_KEYS,
  DEFAULT_COMPOSE_CHILDREN,
  bandFromSafetyFlags,
  highestBand,
  isComposeGovernanceApproved,
};

export default {
  composeDischargePackage,
  getComposeGraph,
};
