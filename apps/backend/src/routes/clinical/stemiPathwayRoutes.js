import { Router } from 'express';

import { STEMI_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import logger from '../../logging/logger.js';
import {
  acknowledgeActivation,
  createActivation,
  getActivation,
  getStemiPathwaySettings,
  listActivations,
  recordActivationDoorTime,
  recordPathwayEvent,
  setStemiPathwaySettings,
  updateActivationStatus,
} from '../../services/clinical/stemiPathwayService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { error, success } from '../../utils/responseHelper.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import { hasRole } from '../../utils/roles.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function actorOf(req) {
  return req.user?.uid || req.user?.id || null;
}

function actorRoleOf(req) {
  return req.user?.role || null;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return undefined;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) {
        return error(res, 'Code-STEMI request could not be completed', err.statusCode, {
          code: err.code,
          details: err.details,
          safe: true,
        });
      }
      logger.error('STEMI pathway route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!hasRole(req.user?.role, STEMI_ROUTE_ROLES)
    && !hasRole(req.user?.rawRole, STEMI_ROUTE_ROLES)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role) && req.user?.role !== 'SUPER_ADMIN') {
    return error(res, 'Administrator role required', 403);
  }
  next();
}

router.get('/settings', requireStaffOrAdmin, wrap(async (req) =>
  getStemiPathwaySettings(tenantOf(req))));

router.patch('/settings', requireAdmin, wrap(async (req) =>
  setStemiPathwaySettings({
    ...req.body,
    tenantId: tenantOf(req),
    actorUid: actorOf(req),
  })));

router.get('/activations', requireStaffOrAdmin, wrap(async (req) =>
  listActivations({
    tenantId: tenantOf(req),
    activeOnly: req.query.active_only ?? req.query.activeOnly,
    status: req.query.status,
    patientUid: req.query.patient_uid ?? req.query.patientUid,
    limit: req.query.limit,
  })));

router.post('/activations', requireStaffOrAdmin, wrap(async (req) =>
  createActivation({
    ...req.body,
    tenantId: tenantOf(req),
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.get('/activations/:id', requireStaffOrAdmin, wrap(async (req) =>
  getActivation({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/activations/:id/status', requireStaffOrAdmin, wrap(async (req) =>
  updateActivationStatus({
    tenantId: tenantOf(req),
    id: req.params.id,
    status: req.body.status,
    standDownReason: req.body.stand_down_reason ?? req.body.standDownReason,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.patch('/activations/:id/clocks', requireStaffOrAdmin, wrap(async (req) =>
  recordActivationDoorTime({
    tenantId: tenantOf(req),
    id: req.params.id,
    doorTimeAt: req.body.door_time_at ?? req.body.doorTimeAt,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.post('/activations/:id/events', requireStaffOrAdmin, wrap(async (req) =>
  recordPathwayEvent({
    ...req.body,
    tenantId: tenantOf(req),
    activationId: req.params.id,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
  })));

router.post('/activations/:id/ack', requireStaffOrAdmin, wrap(async (req) =>
  acknowledgeActivation({
    tenantId: tenantOf(req),
    activationId: req.params.id,
    actorUid: actorOf(req),
    actorRole: actorRoleOf(req),
    acknowledgementNote: req.body.acknowledgement_note ?? req.body.acknowledgementNote,
  })));

export default router;
