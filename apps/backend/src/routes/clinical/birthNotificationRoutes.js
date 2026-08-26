// src/routes/clinical/birthNotificationRoutes.js — G4 (reaudit 2026-08-25)
//
// Birth notification / birth-certificate register (CRS Form 1). Mirrors
// deathCertificationRoutes. Dark-gated in the service layer
// (requireBirthNotificationEnabled): env off → 503 BIRTH_NOTIFICATION_NOT_ENABLED,
// tenant off → 403 BIRTH_NOTIFICATION_DISABLED.

import { Router } from 'express';
import * as svc from '../../services/clinical/birthNotificationService.js';
import { success, relayAppError, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { markRouterDomain } from '../../config/openapiDomain.js';

const router = markRouterDomain(Router(), 'birth-notification');

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
      return relayAppError(res, err, 'Birth notification error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

router.post('/notifications', requireStaffOrAdmin, wrap(async (req) =>
  svc.createBirthNotification({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    actor_role: req.user?.role,
  })));

router.get('/notifications', requireStaffOrAdmin, wrap(async (req) =>
  svc.listBirthNotifications({
    tenantId: tenantOf(req),
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    overdue: req.query.overdue,
    limit: req.query.limit,
  })));

router.get('/notifications/overdue', requireStaffOrAdmin, wrap(async (req) =>
  svc.overdueRegister({ tenantId: tenantOf(req), limit: req.query.limit })));

router.get('/notifications/:id', requireStaffOrAdmin, wrap(async (req) =>
  svc.getBirthNotification({ tenantId: tenantOf(req), id: req.params.id })));

router.get('/notifications/:id/form1', requireStaffOrAdmin, wrap(async (req) =>
  svc.printForm1({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/notifications/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  svc.transition({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    certified_by: req.body.certified_by || req.user?.uid,
    actor_role: req.user?.role,
  })));

export default router;
