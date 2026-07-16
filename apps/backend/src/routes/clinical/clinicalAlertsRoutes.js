// src/routes/clinical/clinicalAlertsRoutes.js
//
// Read surface for the admin Clinical Alerts & Code Blue board. Live data is
// pushed over the staff:clinical-alerts / staff:code-blue WS channels; this
// route only hydrates recent history. Cross-patient operational board — no
// patientAccessGuard (matches the OR-board sibling mount).

import { Router } from 'express';
import * as clinicalAlerts from '../../services/clinical/clinicalAlertsService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
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
      return relayAppError(res, err, 'An internal server error occurred. Please try again later.');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// GET /api/v1/clinical-alerts/recent?hours=8&limit=100
router.get('/recent', requireStaffOrAdmin, wrap(async (req) =>
  clinicalAlerts.listRecentAlerts({
    tenantId: tenantOf(req),
    hours: req.query.hours,
    limit: req.query.limit,
  })));

export default router;
