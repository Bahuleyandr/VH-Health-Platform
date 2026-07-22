/**
 * Clinical-staff results-inbox routes (design §4.5).
 *
 * Mounted at /api/v1/clinical-inbox in app.js, clinical-accountability-gated
 * (requireRole(...CLINICAL_INBOX_ROUTE_ROLES)) + phiAccessLogger.
 *
 * This is a DELIBERATELY MINIMAL 5-endpoint surface — the per-clinician
 * inbox, role-queue claim, acknowledgement, diagnostic disposition, and
 * normal-result reopen — so clinical staff
 * get exactly the safety-net endpoints and NOTHING ELSE. The rest of the
 * tasks/workflow/escalation-rules admin surface (getTask by id, listTasks,
 * upsertEscalationRule, transition/assign, workflow CRUD) stays ADMIN-only at
 * /api/v1/admin/workflow (routes/admin/tasksWorkflowRoutes.js).
 *
 * SECURITY: do NOT mount the full admin tasksWorkflowRoutes router here — that
 * would let any clinical-staff role read any task by id (cross-patient PHI:
 * patient_uid + critical-result title) and disable escalation rules. Both
 * handlers below are scoped to the caller (uid + roles); a regression test
 * (tests/unit/clinicalInboxRoutes.test.js) asserts only these routes exist.
 */

import express from 'express';

import { AppError } from '../utils/AppError.js';
import { success } from '../utils/responseHelper.js';
import { getAuthenticatedActorRoles } from '../utils/roleHelpers.js';
import { isValidIdempotencyKey } from '../services/idempotency/idempotencyService.js';
import { acknowledgeCriticalAlertForInboxTask } from '../services/lab/labResultsService.js';
import {
  recordDoctorDiagnosticDisposition,
  reopenNormalDiagnosticGeneration,
} from '../services/diagnostics/diagnosticResultActionService.js';
import {
  acknowledgeTask,
  claimInboxTask,
  listInboxTasks,
} from '../services/workflow/taskService.js';

const router = express.Router();

function setPhiPatientContext(req, patientUid) {
  if (!patientUid) return;
  req.phiContext = { ...(req.phiContext || {}), patientUid: String(patientUid) };
}

function requireIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    throw AppError.badRequest(
      'Idempotency-Key header is required',
      'TASK_CLAIM_IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'TASK_CLAIM_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

// GET /tasks/inbox — the caller's open / in_progress / overdue work (assignee =
// me OR my role), ordered by priority then due_at. Thin wrapper over
// taskService.listInboxTasks, scoped to req.user.uid + roles.
router.get('/tasks/inbox', async (req, res, next) => {
  try {
    const result = await listInboxTasks({
      tenantId: req.tenantId,
      assigneeUid: req.user?.uid || null,
      roles: getAuthenticatedActorRoles(req.user),
      primaryRole: req.user?.role || null,
      rawRole: req.user?.rawRole || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Inbox retrieved');
  } catch (err) { return next(err); }
});

router.post('/tasks/:id/claim', async (req, res, next) => {
  try {
    if (Object.keys(req.body || {}).length > 0) {
      throw AppError.badRequest(
        'Task claim request body must be empty',
        'TASK_CLAIM_BODY_INVALID',
      );
    }
    const row = await claimInboxTask({
      tenantId: req.tenantId,
      id: req.params.id,
      actorUid: req.user?.uid || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorPrimaryRole: req.user?.role || null,
      actorRawRole: req.user?.rawRole || null,
      idempotencyKey: requireIdempotencyKey(req),
    });
    setPhiPatientContext(req, row?.patient_uid);
    return success(res, row, row?.replayed ? 'Task claim replayed' : 'Task claimed');
  } catch (err) {
    setPhiPatientContext(req, err?.phiPatientUid);
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to claim this task'));
    }
    return next(err);
  }
});

// POST /tasks/:id/acknowledge — open|overdue → in_progress (stops the escalation
// clock, §4.5). actorUid is the caller; acknowledgeTask stamps metadata + an
// audit comment and is idempotent for an already-acknowledged task.
router.post('/tasks/:id/acknowledge', async (req, res, next) => {
  try {
    const actorRoles = getAuthenticatedActorRoles(req.user);
    const criticalAlertResult = await acknowledgeCriticalAlertForInboxTask(req.params.id, {
      tenantId: req.tenantId,
      actorUid: req.user?.uid || null,
      actorName: req.user?.name || null,
      actorRoles,
      actorRole: req.user?.role
        || (Array.isArray(req.user?.roles) ? req.user.roles[0] : req.user?.roles)
        || null,
      actorRawRole: req.user?.rawRole || null,
      breakGlassId: req.body?.break_glass_id ?? null,
      readBackMethod: req.body?.read_back_method ?? null,
      notes: req.body?.notes ?? null,
    });
    const row = criticalAlertResult.handled
      ? criticalAlertResult.task
      : await acknowledgeTask({
        tenantId: req.tenantId,
        id: req.params.id,
        actorUid: req.user?.uid || null,
        actorRoles,
        actorPrimaryRole: req.user?.role || null,
        actorRawRole: req.user?.rawRole || null,
        breakGlassId: req.body?.break_glass_id ?? null,
      });
    setPhiPatientContext(req, row?.patient_uid);
    return success(res, row, 'Task acknowledged');
  } catch (err) {
    setPhiPatientContext(req, err?.phiPatientUid);
    // A missing id and a forbidden existing task are deliberately
    // indistinguishable on this PHI-bearing clinical surface.
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to acknowledge this task'));
    }
    return next(err);
  }
});

router.post('/diagnostic-results/:generationId/actions', async (req, res, next) => {
  try {
    const allowed = new Set([
      'task_id',
      'disposition',
      'clinical_note',
      'reason',
      'generation_snapshot_sha256',
      'downstream_evidence',
      'attested',
    ]);
    if (Object.keys(req.body || {}).some((field) => !allowed.has(field))) {
      throw AppError.badRequest(
        'Diagnostic action request contains unsupported fields',
        'DIAGNOSTIC_ACTION_INPUT_INVALID',
      );
    }
    if (req.body?.attested !== true) {
      throw AppError.badRequest(
        'Explicit electronic attestation is required',
        'DIAGNOSTIC_ACTION_ATTESTATION_REQUIRED',
      );
    }
    const receipt = await recordDoctorDiagnosticDisposition({
      tenantId: req.tenantId,
      generationId: req.params.generationId,
      taskId: req.body?.task_id,
      disposition: req.body?.disposition,
      clinicalNote: req.body?.clinical_note,
      reason: req.body?.reason,
      generationSnapshotSha256: req.body?.generation_snapshot_sha256,
      downstreamEvidence: req.body?.downstream_evidence,
      attested: req.body?.attested,
      idempotencyKey: requireIdempotencyKey(req),
    }, {
      actorUid: req.user?.uid || null,
      actorName: req.user?.name || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorRole: req.user?.role || null,
      actorRawRole: req.user?.rawRole || null,
    });
    return success(res, receipt, receipt.replayed
      ? 'Diagnostic action replayed'
      : 'Diagnostic action recorded');
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to record this diagnostic action'));
    }
    return next(err);
  }
});

router.post('/diagnostic-results/:generationId/reopen', async (req, res, next) => {
  try {
    const allowed = new Set(['reason']);
    if (Object.keys(req.body || {}).some((field) => !allowed.has(field))) {
      throw AppError.badRequest(
        'Diagnostic reopen request contains unsupported fields',
        'DIAGNOSTIC_ACTION_INPUT_INVALID',
      );
    }
    const receipt = await reopenNormalDiagnosticGeneration({
      tenantId: req.tenantId,
      generationId: req.params.generationId,
      reason: req.body?.reason,
      idempotencyKey: requireIdempotencyKey(req),
    }, {
      actorUid: req.user?.uid || null,
      actorName: req.user?.name || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorRole: req.user?.role || null,
      actorRawRole: req.user?.rawRole || null,
    });
    return success(res, receipt, receipt.replayed
      ? 'Diagnostic reopen replayed'
      : 'Diagnostic result reopened');
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) {
      return next(AppError.forbidden('Not authorized to reopen this diagnostic result'));
    }
    return next(err);
  }
});

export default router;
