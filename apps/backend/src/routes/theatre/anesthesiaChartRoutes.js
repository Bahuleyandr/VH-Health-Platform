// src/routes/theatre/anesthesiaChartRoutes.js — Sprint 17

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/theatre/anesthesiaChartService.js';
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
      logger.error('anesthesia route error:', err);
      return error(res, err.message || 'Anesthesia error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

router.post('/entries', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordEntry({
    tenantId: tenantOf(req), recorded_by: req.user?.uid, ...req.body,
  }),
));

router.get('/entries/case/:scheduleId', requireStaffOrAdmin, wrap(async (req) =>
  svc.listForCase({
    tenantId: tenantOf(req), ot_schedule_id: req.params.scheduleId,
  }),
));

router.get('/totals/case/:scheduleId', requireStaffOrAdmin, wrap(async (req) =>
  svc.totalsForCase({
    tenantId: tenantOf(req), ot_schedule_id: req.params.scheduleId,
  }),
));

export default router;
