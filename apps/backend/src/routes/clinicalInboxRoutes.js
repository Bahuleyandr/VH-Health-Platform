/**
 * Clinical-staff results-inbox routes (design §4.5).
 *
 * Mounted at /api/v1/clinical-inbox in app.js, clinical-staff-gated
 * (requireRole(...CLINICAL_STAFF_ROUTE_ROLES)) + phiAccessLogger.
 *
 * This is a DELIBERATELY MINIMAL 2-endpoint surface — the per-clinician
 * "open critical work for me / my role" inbox + acknowledge — so clinical staff
 * get exactly the safety-net endpoints and NOTHING ELSE. The rest of the
 * tasks/workflow/escalation-rules admin surface (getTask by id, listTasks,
 * upsertEscalationRule, transition/assign, workflow CRUD) stays ADMIN-only at
 * /api/v1/admin/workflow (routes/admin/tasksWorkflowRoutes.js).
 *
 * SECURITY: do NOT mount the full admin tasksWorkflowRoutes router here — that
 * would let any clinical-staff role read any task by id (cross-patient PHI:
 * patient_uid + critical-result title) and disable escalation rules. Both
 * handlers below are scoped to the caller (uid + roles); a regression test
 * (tests/unit/clinicalInboxRoutes.test.js) asserts only these two routes exist.
 */

import express from 'express';

import { success } from '../utils/responseHelper.js';
import { acknowledgeTask, listInboxTasks } from '../services/workflow/taskService.js';

const router = express.Router();

// GET /tasks/inbox — the caller's open / in_progress / overdue work (assignee =
// me OR my role), ordered by priority then due_at. Thin wrapper over
// taskService.listInboxTasks, scoped to req.user.uid + roles.
router.get('/tasks/inbox', async (req, res, next) => {
  try {
    const result = await listInboxTasks({
      tenantId: req.tenantId,
      assigneeUid: req.user?.uid || null,
      roles: req.user?.roles || (req.user?.role ? [req.user.role] : []),
      limit: req.query.limit,
    });
    return success(res, result, 'Inbox retrieved');
  } catch (err) { return next(err); }
});

// POST /tasks/:id/acknowledge — open|overdue → in_progress (stops the escalation
// clock, §4.5). actorUid is the caller; acknowledgeTask stamps metadata + an
// audit comment and is idempotent for an already-acknowledged task.
router.post('/tasks/:id/acknowledge', async (req, res, next) => {
  try {
    const row = await acknowledgeTask({
      tenantId: req.tenantId,
      id: req.params.id,
      actorUid: req.user?.uid || null,
      actorRoles: req.user?.roles || (req.user?.role ? [req.user.role] : []),
      overrideReason: req.body?.override_reason || null,
    });
    return success(res, row, 'Task acknowledged');
  } catch (err) { return next(err); }
});

export default router;
