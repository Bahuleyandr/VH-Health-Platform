// src/routes/publicHealth/publicHealthRoutes.js — G1 (reaudit 2026-08-25)
//
// Statutory public-health notifiable-disease register + Nikshay/IDSP/HMIS
// export files. Dark-gated in the service layer: env off → 503
// PUBLIC_HEALTH_REGISTERS_NOT_ENABLED, tenant off → 403
// PUBLIC_HEALTH_REGISTERS_DISABLED.

import { Router } from 'express';
import * as svc from '../../services/publicHealth/publicHealthService.js';
import { success, relayAppError, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { markRouterDomain } from '../../config/openapiDomain.js';

const router = markRouterDomain(Router(), 'public-health-register');

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
      return relayAppError(res, err, 'Public health register error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── Register CRUD ──────────────────────────────────────────────────────────
router.post('/notifications', requireStaffOrAdmin, wrap(async (req) =>
  svc.createNotification({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    reported_by: req.body.reported_by || req.user?.uid,
    actor_role: req.user?.role,
  })));

router.get('/notifications', requireStaffOrAdmin, wrap(async (req) =>
  svc.listNotifications({
    tenantId: tenantOf(req),
    program: req.query.program,
    status: req.query.status,
    disease_code: req.query.disease_code,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
  })));

router.get('/notifications/:id', requireStaffOrAdmin, wrap(async (req) =>
  svc.getNotification({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/notifications/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  svc.transition({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  })));

// ── Submission-format export files ──────────────────────────────────────────
router.get('/exports/nikshay', requireStaffOrAdmin, wrap(async (req) =>
  svc.exportNikshayTb({ tenantId: tenantOf(req), from: req.query.from, to: req.query.to })));

router.get('/exports/idsp', requireStaffOrAdmin, wrap(async (req) =>
  svc.exportIdspWeekly({
    tenantId: tenantOf(req), from: req.query.from, to: req.query.to,
    form: req.query.form === 'S' ? 'S' : 'P',
  })));

router.get('/exports/hmis', requireStaffOrAdmin, wrap(async (req) =>
  svc.exportHmisMonthly({
    tenantId: tenantOf(req), month: req.query.month, year: req.query.year,
  })));

export default router;
