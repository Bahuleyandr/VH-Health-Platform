/**
 * Admin control-plane routes for the prior_auth_appeal_chain meta-workflow.
 *
 * Exposes HTTP endpoints so the admin UI can:
 *
 *   POST /prior-auth/:id/appeal              start (or smoke-test) the appeal chain
 *   GET  /prior-auth-appeal/:runId           fetch a run + its children tree
 *   POST /prior-auth-appeal/:runId/resume    resume a paused run
 *   POST /prior-auth-appeal/:runId/fail      manually fail a paused run
 *
 * Final paths (mounted under the control-plane base):
 *   POST /api/v1/admin/clinical-ai/prior-auth/:id/appeal
 *   GET  /api/v1/admin/clinical-ai/prior-auth-appeal/:runId
 *   POST /api/v1/admin/clinical-ai/prior-auth-appeal/:runId/resume
 *   POST /api/v1/admin/clinical-ai/prior-auth-appeal/:runId/fail
 *
 * RBAC is inherited from the parent router (see clinicalAiRoutes.js
 * which mounts requireClinicalAiControl). The start endpoint also
 * inherits the appeal_letter_generator module gate from the service.
 *
 * Pattern mirrors dischargeComposeRoutes.js exactly.
 */

import express from 'express';
import { success, error } from '../../../utils/responseHelper.js';
import { AppError } from '../../../utils/AppError.js';
import { logClinicalAiAudit } from './audit.js';
import {
  composePriorAuthAppeal,
  getPriorAuthAppealGraph,
  WORKFLOW_KEY,
} from '../../../services/ai/priorAuthAppealChainService.js';
import { getDefaultCheckpointStore } from '../../../services/ai/workflowCheckpointStore.js';
import { resumeWorkflow } from '../../../services/ai/workflowGraphRunner.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /prior-auth/:id/appeal — start a fresh appeal chain for a prior auth
//
// This is also the local-Ollama smoke-test hook: hit it manually against a
// denied PA row to exercise the full LLM path end-to-end.
// ---------------------------------------------------------------------------
router.post('/prior-auth/:id/appeal', async (req, res, next) => {
  try {
    const priorAuthId = Number.parseInt(req.params?.id, 10);
    if (!Number.isFinite(priorAuthId)) {
      return error(res, 'Invalid prior_auth_id', 400, { code: 'INVALID_PRIOR_AUTH_ID' });
    }

    const result = await composePriorAuthAppeal(priorAuthId, {
      startedBy: req.user?.uid || null,
      req,
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_STARTED',
      String(priorAuthId),
      null,
      {
        prior_auth_id: priorAuthId,
        status: result.status || 'completed',
        run_id: result.run_id || null,
        pause_reason: result.pause_reason || null,
      }
    );

    // Paused → 202 (accepted; chain continues asynchronously via resume).
    // Completed (rare sync path) → 201 (the appeal record is ready).
    const statusCode = result.status === 'paused' ? 202 : 201;
    return success(res, result, 'Prior-auth appeal chain dispatched', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /prior-auth-appeal/:runId — fetch a run + its children
// ---------------------------------------------------------------------------
router.get('/prior-auth-appeal/:runId', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.workflow_key !== WORKFLOW_KEY) {
      throw AppError.notFound('Run is not a prior-auth appeal');
    }

    const children = await store.listChildren(runId);

    return success(res, {
      run,
      children,
      child_count: children.length,
    }, 'Prior-auth appeal run retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /prior-auth-appeal/:runId/resume — resume a paused run
//
// Typical trigger: an admin (or a future scheduler) calls this after the
// human disposition gate has been satisfied (appeal submitted or payer
// decision recorded). Idempotent on completed runs.
// ---------------------------------------------------------------------------
router.post('/prior-auth-appeal/:runId/resume', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.workflow_key !== WORKFLOW_KEY) {
      throw AppError.badRequest('Run is not a prior-auth appeal', 'WRONG_WORKFLOW_KEY');
    }

    const outcome = await resumeWorkflow({
      runId,
      store,
      graph: getPriorAuthAppealGraph(),
      ctx: { req },
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_RESUMED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: outcome.status, pause_reason: outcome.pauseReason || null }
    );

    const statusCode = outcome.status === 'paused' ? 202 : 200;
    return success(res, outcome, 'Prior-auth appeal run resumed', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /prior-auth-appeal/:runId/fail — admin escape hatch for stuck runs
//
// Used when a pause gate will never fire (e.g. payer is unresponsive, or
// the appeal has been withdrawn outside the system). Admin/control-plane only.
// ---------------------------------------------------------------------------
router.post('/prior-auth-appeal/:runId/fail', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      throw AppError.notFound('Appeal run not found');
    }
    if (run.workflow_key !== WORKFLOW_KEY) {
      throw AppError.notFound('Run is not a prior-auth appeal');
    }
    if (run.status !== 'paused') {
      throw AppError.conflict('Only paused appeal runs can be manually failed', 'APPEAL_RUN_NOT_PAUSED', {
        status: run.status,
      });
    }

    const reason = String(
      req.body?.reason || 'Manually failed by admin from prior-auth appeal dashboard'
    ).slice(0, 4000);

    await store.markFailed(runId, run.state || {}, {
      node: 'manual_fail',
      message: reason,
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_MANUALLY_FAILED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: 'failed', manual_reason: reason }
    );

    return success(res, {
      status: 'failed',
      runId,
      reason,
    }, 'Prior-auth appeal run marked failed');
  } catch (err) {
    return next(err);
  }
});

export default router;
