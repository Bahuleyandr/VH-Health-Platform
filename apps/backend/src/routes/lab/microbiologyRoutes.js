// src/routes/lab/microbiologyRoutes.js — Sprint 17

import { Router } from 'express';
import * as micro from '../../services/lab/microbiologyService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitMicroEvent } from '../../utils/websocket/realtimeEmitter.js';

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
      // Shared relay (responseHelper.relayAppError): surfaces AppError
      // code+details per the documented envelope; non-AppErrors get a logged
      // generic 500 that never relays raw err.message.
      return relayAppError(res, err, 'Microbiology error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Orders
router.post('/orders', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.createOrder({ ...req.body, tenantId, ordered_by: req.user?.uid });
  emitMicroEvent('order-created', { tenantId });
  return row;
}));

router.get('/orders', requireStaffOrAdmin, wrap(async (req) =>
  micro.listOrders({
    tenantId: tenantOf(req),
    status: req.query.status,
    patient_uid: req.query.patient_uid,
    limit: req.query.limit,
  }),
));

router.get('/orders/:id', requireStaffOrAdmin, wrap(async (req) =>
  micro.getOrder({ tenantId: tenantOf(req), id: req.params.id }),
));

router.post('/orders/:id/transition', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.transitionOrder({
    ...req.body,
    tenantId, id: req.params.id, finalised_by: req.user?.uid,
  });
  emitMicroEvent('order-transition', { tenantId });
  return row;
}));

// Isolates
router.post('/orders/:id/isolates', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.addIsolate({ ...req.body, tenantId, order_id: req.params.id });
  emitMicroEvent('isolate-added', { tenantId });
  return row;
}));

// Sensitivities
router.post('/isolates/:id/sensitivities', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await micro.addSensitivity({ ...req.body, tenantId, isolate_id: req.params.id });
  emitMicroEvent('sensitivity-added', { tenantId });
  return row;
}));

// Antibiogram + resistance dashboard
router.get('/antibiogram', requireStaffOrAdmin, wrap(async (req) =>
  micro.antibiogram90d({
    tenantId: tenantOf(req),
    organism: req.query.organism,
    antibiotic: req.query.antibiotic,
    limit: req.query.limit,
  }),
));

router.get('/resistant-isolates', requireStaffOrAdmin, wrap(async (req) =>
  micro.listResistantIsolates({
    tenantId: tenantOf(req), limit: req.query.limit,
  }),
));

export default router;
