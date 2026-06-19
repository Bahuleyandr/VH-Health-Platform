// src/routes/clinical/nursingAssessmentRoutes.js
//
// Sprint 15 — NEWS2 + Braden + Morse + sepsis screen.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/clinical/nursingAssessmentService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('nursing-assessment route error:', err);
      return error(res, err.message || 'Assessment error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Pure-compute scoring without persisting (for previews / "what would this score").
router.post('/score', requireStaffOrAdmin, wrap(async (req) => {
  const { kind, inputs } = req.body ?? {};
  return svc.score(kind, inputs ?? {});
}));

router.post('/', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordAssessment({
    tenantId: tenantOf(req),
    assessed_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/patient/:uid', requireStaffOrAdmin, wrap(async (req) =>
  svc.listForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.uid,
    kind: req.query.kind,
    limit: req.query.limit,
  }),
));

router.get('/dashboard/overdue-or-high-risk', requireStaffOrAdmin, wrap(async (req) =>
  svc.listOverdueOrHighRisk({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

export default router;
