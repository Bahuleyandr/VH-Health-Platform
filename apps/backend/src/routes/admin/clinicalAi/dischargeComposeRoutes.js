/**
 * Admin routes for the discharge_summary_compose meta-workflow.
 *
 * Wires composeDischargePackage + the workflow-runs store to HTTP so the
 * admin UI can:
 *
 *   POST /discharge-compose          start a fresh compose run
 *   GET  /discharge-compose/:runId   fetch a run + its children tree
 *   POST /discharge-compose/:runId/resume   resume a paused run
 *   POST /discharge-compose/:runId/fail     manually fail a paused run
 *   GET  /discharge-compose          list recent compose runs (top-level)
 *
 * RBAC is inherited from the parent router (see clinicalAiRoutes.js
 * which mounts requireClinicalAiControl). The compose module is itself
 * gated by clinical_ai_modules.enabled — composeDischargePackage rejects
 * with FORBIDDEN when the module is disabled for the tenant.
 */

import express from 'express';
import { success, error } from '../../../utils/responseHelper.js';
import prisma from '../../../lib/prisma.js';
import { AppError } from '../../../utils/AppError.js';
import { patientAccessGuardForResource } from '../../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../../services/security/accessDecisionService.js';
import { logClinicalAiAudit } from './audit.js';
import {
  composeDischargePackage,
  getComposeGraph,
  DISCHARGE_COMPOSE_WORKFLOW_KEY,
} from '../../../services/ai/dischargeComposeService.js';
import {
  getDefaultCheckpointStore,
} from '../../../services/ai/workflowCheckpointStore.js';
import { resumeWorkflow } from '../../../services/ai/workflowGraphRunner.js';

const router = express.Router();

// Intra-tenant IDOR guard for the compose entrypoint — resolve the patient
// owning the admission (tenant-scoped) and enforce the actor's care
// relationship before composeDischargePackage reads PHI. Care-team-mode-
// governed (per-tenant, default 'shadow') to match the platform's ABAC
// rollout posture; a tenant flipped to 'enforce' returns a real 403 for an
// out-of-relationship admission id. The hard cross-tenant guarantee is the
// tenant_id predicate added to resolvePatientUid in dischargeComposeService.js.
const guardComposeAdmission = patientAccessGuardForResource('ADMISSION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
  resourceType: 'admission',
  idSelector: (req) => req.body?.admission_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});

function clampInt(value, { min = 1, max = 100, fallback = 25 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ---------------------------------------------------------------------------
// POST /discharge-compose — start a fresh compose run for an admission
// ---------------------------------------------------------------------------
router.post('/discharge-compose', guardComposeAdmission, async (req, res, next) => {
  try {
    const admissionId = req.body?.admission_id;
    if (!admissionId) {
      return error(res, 'admission_id is required', 400, { code: 'ADMISSION_ID_REQUIRED' });
    }

    const result = await composeDischargePackage(
      admissionId,
      req.user?.uid || null,
      req
    );

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_GENERATED',
      String(result.compose_generation_id || result.run_id || admissionId),
      null,
      {
        admission_id: admissionId,
        compose_generation_id: result.compose_generation_id || null,
        compose_children: result.compose_children || null,
        overall_safety_band: result.overall_safety_band || null,
        status: result.status || 'completed',
        run_id: result.run_id || null,
      }
    );

    // The compose service may return either a completed result or a
    // paused stub. The HTTP status reflects this:
    //   completed -> 201 (a new generation exists)
    //   paused    -> 202 (accepted; resume required)
    const statusCode = result.status === 'paused' ? 202 : 201;
    return success(res, result, 'Discharge compose dispatched', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discharge-compose — list recent compose runs (top-level only)
// ---------------------------------------------------------------------------
router.get('/discharge-compose', async (req, res, next) => {
  try {
    const limit = clampInt(req.query?.limit, { min: 1, max: 100, fallback: 25 });
    const status = req.query?.status ? String(req.query.status).slice(0, 40) : null;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, workflow_key, module_key, patient_uid, admission_id,
              status, current_node, pause_reason, started_at, paused_at,
              completed_at, failed_at, metadata
       FROM clinical_ai_workflow_runs
       WHERE tenant_id = $1::uuid
         AND workflow_key = $2
         AND parent_run_id IS NULL
         AND ($3::text IS NULL OR status = $3)
       ORDER BY started_at DESC
       LIMIT $4`,
      req.tenantId,
      DISCHARGE_COMPOSE_WORKFLOW_KEY,
      status,
      limit
    );

    return success(res, { runs: rows, count: rows.length }, 'Discharge compose runs retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /discharge-compose/:runId — fetch a run + its children tree
// ---------------------------------------------------------------------------
router.get('/discharge-compose/:runId', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Compose run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      // Cross-tenant lookups are blocked even with admin role — RLS
      // would also catch this, but a 404 keeps the response consistent.
      throw AppError.notFound('Compose run not found');
    }
    if (run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Run is not a discharge compose');
    }

    const children = await store.listChildren(runId);

    return success(res, {
      run,
      children,
      child_count: children.length,
    }, 'Discharge compose run retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose/:runId/resume — resume a paused run
//
// The expected use case: an external system flipped a clinical_ai_approvals
// row to 'approved' and an admin (or a future scheduler) hits this endpoint
// to advance the parent. Idempotent — re-calling on a completed run
// returns the same final result.
// ---------------------------------------------------------------------------
router.post('/discharge-compose/:runId/resume', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Compose run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      throw AppError.notFound('Compose run not found');
    }
    if (run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Run is not a discharge compose');
    }

    const outcome = await resumeWorkflow({
      runId,
      store,
      graph: getComposeGraph(),
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_RESUMED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: outcome.status, pause_reason: outcome.pauseReason || null }
    );

    const statusCode = outcome.status === 'paused' ? 202 : 200;
    return success(res, outcome, 'Discharge compose resumed', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose/:runId/fail — admin escape hatch for paused runs
//
// Used when an external pause gate will never fire (for example, a pilot
// signoff was rejected or expired). This is intentionally admin/control-plane
// only: clinicians can review or reject drafts, but they should not manually
// mutate workflow-run terminal state.
// ---------------------------------------------------------------------------
router.post('/discharge-compose/:runId/fail', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run) {
      throw AppError.notFound('Compose run not found');
    }
    if (run.tenant_id !== req.tenantId) {
      throw AppError.notFound('Compose run not found');
    }
    if (run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Run is not a discharge compose');
    }
    if (run.status !== 'paused') {
      throw AppError.conflict('Only paused compose runs can be manually failed', 'COMPOSE_RUN_NOT_PAUSED', {
        status: run.status,
      });
    }

    const reason = String(
      req.body?.reason || 'Manually failed by admin from discharge-compose dashboard'
    ).slice(0, 4000);

    await store.markFailed(runId, run.state || {}, {
      node: 'manual_fail',
      message: reason,
    });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_MANUALLY_FAILED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: 'failed', manual_reason: reason }
    );

    return success(res, {
      status: 'failed',
      runId,
      reason,
    }, 'Discharge compose run marked failed');
  } catch (err) {
    return next(err);
  }
});

export default router;
