/**
 * Clinical-use routes — the point-of-care surface.
 *
 * Mounted at /api/v1/clinical-ai/clinical/*. Gated by
 * requireClinicalAiUse (clinical roles + ADMIN/SUPER_ADMIN; see
 * CLINICAL_AI_USER_ROLES_LIST in shared.js).
 *
 * This is what the apps/staff Flutter app + Flutter web build will
 * call. It deliberately DOES NOT expose governance, model registry,
 * audit, or break-glass — those stay on /api/v1/clinical-ai/control/*
 * (alias of the existing /api/v1/admin/clinical-ai/*).
 *
 * Phase 0 of the clinical-AI rollout plan
 * (docs/CLINICAL_AI_ROLLOUT_PLAN.md). The endpoints below are the
 * minimum-viable clinician surface; later phases will expand it as
 * Flutter screens are built (Phase 2).
 *
 * Endpoints exposed:
 *
 *   POST /admission-ai-draft
 *     Generate a draft for one of the ADMISSION_MODULES against an
 *     admission. Mirrors the existing admin endpoint but the audit
 *     event records the clinician role and the route family.
 *
 *   POST /discharge-compose
 *   GET  /discharge-compose
 *   GET  /discharge-compose/:runId
 *   POST /discharge-compose/:runId/resume
 *     Same shapes as /api/v1/admin/clinical-ai/discharge-compose/*
 *     (see dischargeComposeRoutes.js). Reused service functions; no
 *     business-logic divergence between control + clinical paths.
 *
 *   GET  /reviews
 *     List reviews where the caller's role is in the module's
 *     reviewRoles. Differs from /control/reviews which lists ALL
 *     reviews tenant-wide for governance.
 *
 *   PATCH /reviews/:id
 *     Sign / edit / reject a review. updateReview() in the workflow
 *     service does the per-module reviewRoles check internally — a
 *     DOCTOR can't sign off on a review that requires PHARMACY_STAFF.
 */

import express from 'express';
import { success, error } from '../../../utils/responseHelper.js';
import prisma from '../../../lib/prisma.js';
import { AppError } from '../../../utils/AppError.js';
import { logClinicalAiAudit } from './audit.js';
import { requireClinicalAiUse, normalizeRole } from './shared.js';
import { generateAdmissionAiDraft, listReviews, updateReview } from '../../../services/ai/clinicalAiWorkflowService.js';
import {
  composeDischargePackage,
  getComposeGraph,
  DISCHARGE_COMPOSE_WORKFLOW_KEY,
} from '../../../services/ai/dischargeComposeService.js';
import { getDefaultCheckpointStore } from '../../../services/ai/workflowCheckpointStore.js';
import { resumeWorkflow } from '../../../services/ai/workflowGraphRunner.js';

const router = express.Router();

// Defense-in-depth: outer guard is requireRole(...CLINICAL_AI_USER_ROLES)
// at the app.js mount; this is the inner guard. Both must pass.
router.use(requireClinicalAiUse);

function clampInt(value, { min = 1, max = 100, fallback = 25 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// ---------------------------------------------------------------------------
// POST /admission-ai-draft — generate a draft for an admission + module
// ---------------------------------------------------------------------------
router.post('/admission-ai-draft', async (req, res, next) => {
  try {
    const admissionId = req.body?.admission_id;
    const moduleKey = req.body?.module_key;
    if (!admissionId) {
      return error(res, 'admission_id is required', 400, { code: 'ADMISSION_ID_REQUIRED' });
    }
    if (!moduleKey) {
      return error(res, 'module_key is required', 400, { code: 'MODULE_KEY_REQUIRED' });
    }

    const result = await generateAdmissionAiDraft(
      admissionId,
      moduleKey,
      req.user?.uid || null,
      req
    );

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ADMISSION_DRAFT_GENERATED',
      String(result.generation_id || admissionId),
      null,
      {
        admission_id: admissionId,
        module_key: moduleKey,
        generation_id: result.generation_id || null,
        review_id: result.review_id || null,
        safety_flag_count: result.safety_flags?.length || 0,
        route_family: 'clinical',
      }
    );
    return success(res, result, 'Admission AI draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose — start a fresh compose (clinician)
// ---------------------------------------------------------------------------
router.post('/discharge-compose', async (req, res, next) => {
  try {
    const admissionId = req.body?.admission_id;
    if (!admissionId) {
      return error(res, 'admission_id is required', 400, { code: 'ADMISSION_ID_REQUIRED' });
    }

    const result = await composeDischargePackage(admissionId, req.user?.uid || null, req);

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
        route_family: 'clinical',
      }
    );

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
// GET /discharge-compose/:runId — fetch run + children tree
// ---------------------------------------------------------------------------
router.get('/discharge-compose/:runId', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run || run.tenant_id !== req.tenantId || run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Compose run not found');
    }
    const children = await store.listChildren(runId);
    return success(res, { run, children, child_count: children.length }, 'Discharge compose run retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /discharge-compose/:runId/resume — resume a paused run (clinician)
// ---------------------------------------------------------------------------
router.post('/discharge-compose/:runId/resume', async (req, res, next) => {
  try {
    const runId = Number.parseInt(req.params?.runId, 10);
    if (!Number.isFinite(runId)) {
      return error(res, 'Invalid runId', 400, { code: 'INVALID_RUN_ID' });
    }

    const store = getDefaultCheckpointStore();
    const run = await store.getRun(runId);
    if (!run || run.tenant_id !== req.tenantId || run.workflow_key !== DISCHARGE_COMPOSE_WORKFLOW_KEY) {
      throw AppError.notFound('Compose run not found');
    }

    const outcome = await resumeWorkflow({ runId, store, graph: getComposeGraph() });

    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_DISCHARGE_COMPOSE_RESUMED',
      String(runId),
      { status_before: run.status, pause_reason: run.pause_reason },
      { status_after: outcome.status, pause_reason: outcome.pauseReason || null, route_family: 'clinical' }
    );

    const statusCode = outcome.status === 'paused' ? 202 : 200;
    return success(res, outcome, 'Discharge compose resumed', statusCode);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /reviews — caller's review queue
//
// Filtered to reviews whose module's reviewRoles[] contains the caller's
// role. (listReviews already supports filtering by reviewer_role; we
// just pass the caller's role automatically here, which differs from
// /control/reviews where governance can pass any reviewer_role.)
// ---------------------------------------------------------------------------
router.get('/reviews', async (req, res, next) => {
  try {
    const callerRole = normalizeRole(req.user?.role);
    const reviews = await listReviews({
      tenantId: req.tenantId,
      decision: req.query?.decision || null,
      moduleKey: req.query?.module_key || null,
      reviewerRole: callerRole, // forced — clinicians see only their own queue
      limit: req.query?.limit,
    });
    return success(res, reviews, 'Clinical AI reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /reviews/:id — sign / edit / reject (per-module reviewRoles enforced
// in updateReview)
// ---------------------------------------------------------------------------
router.patch('/reviews/:id', async (req, res, next) => {
  try {
    const review = await updateReview(
      req.params.id,
      req.body || {},
      req.user?.uid || null,
      normalizeRole(req.user?.role),
      { tenantId: req.tenantId }
    );
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_REVIEW_UPDATED',
      String(req.params.id),
      null,
      { ...review, route_family: 'clinical' }
    );
    return success(res, review, 'Clinical AI review updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
