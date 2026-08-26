// NL13-P1f — cath scheduling on the Scheduling 2.0 rails, mounted inside the
// existing /api/v1/cath-lab family (see cathLabRoutes.js). Room inventory is
// owner-managed through /api/v1/scheduling/resources; nothing here creates
// rooms. Emergency cases never book — the service enforces the bypass.

import { Router } from 'express';
import {
  addRegistryEntry,
  cancelCaseSchedule,
  getCaseSchedule,
  getScheduleStrip,
  scheduleCase
} from '../../services/clinical/cathSchedulingRegistryService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { canUseCathWorkflow, canViewCathReport } from '../../utils/roleHelpers.js';
import { cathCaseGuard } from './cathLabAccessGuards.js';

const router = Router();

// Re-audit M: per-route patient access guards (CLINICAL_WORKFLOW) — the
// /api/v1/cath-lab mount guard could never resolve a patient (empty
// req.params before route match); see cathLabAccessGuards.js. Every
// /cases/:id/* route here is about ONE case's patient and carries the guard;
// GET /schedule is the day strip (no single patient subject) and keeps the
// role gate only.
const guardCathCaseById = cathCaseGuard('id');

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function contextOf(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || req.user?.rawRole || null,
    requestId: req.id || null,
    ipAddress: req.ip || null,
    userAgent: req.get?.('user-agent') || null
  };
}

function hasRole(req, predicate) {
  return [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : [])
  ].some(role => predicate(role));
}

function roleGuard(predicate, message, code) {
  return (req, res, next) => {
    if (hasRole(req, predicate)) return next();
    return error(res, message, HTTP_STATUS.FORBIDDEN, { code });
  };
}

const requireCathWorkflow = roleGuard(
  canUseCathWorkflow,
  'Cath-lab workflow access is required',
  'CATH_LAB_WORKFLOW_FORBIDDEN'
);
const requireCathRead = roleGuard(
  role => canViewCathReport(role) || canUseCathWorkflow(role),
  'Cath-lab read access is required',
  'CATH_LAB_READ_FORBIDDEN'
);

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.get('/schedule', requireCathRead, async (req, res) => {
  try {
    const strip = await getScheduleStrip({
      tenantId: tenantOf(req),
      date: req.query.date || null
    });
    return success(res, strip, 'Cath schedule strip');
  } catch (err) {
    return handleFailure(res, err, 'load schedule strip');
  }
});

router.get('/cases/:id/schedule', requireCathRead, guardCathCaseById, async (req, res) => {
  try {
    const schedule = await getCaseSchedule(req.params.id, { tenantId: tenantOf(req) });
    return success(res, schedule, 'Cath case schedule');
  } catch (err) {
    return handleFailure(res, err, 'load case schedule');
  }
});

router.post('/cases/:id/schedule', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const link = await scheduleCase(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { link }, 'Cath case booked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'book case');
  }
});

router.post('/cases/:id/schedule/cancel', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const link = await cancelCaseSchedule(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { link }, 'Cath case booking cancelled');
  } catch (err) {
    return handleFailure(res, err, 'cancel case booking');
  }
});

router.post('/cases/:id/complications', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const entry = await addRegistryEntry(
      req.params.id,
      { ...req.body, tenantId: tenantOf(req) },
      contextOf(req)
    );
    return success(res, { entry }, 'Cath complication registry entry recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record complication registry entry');
  }
});

export default router;
