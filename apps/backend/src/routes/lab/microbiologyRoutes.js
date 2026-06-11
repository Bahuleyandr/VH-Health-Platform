// src/routes/lab/microbiologyRoutes.js — Sprint 17

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as micro from '../../services/lab/microbiologyService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function tenantOf(req) {
  return req?.tenantId || req?.user?.tenant_id || req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('micro route error:', err);
      return error(res, err.message || 'Microbiology error', 500);
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
router.post('/orders', requireStaffOrAdmin, wrap(async (req) =>
  micro.createOrder({
    tenantId: tenantOf(req), ordered_by: req.user?.uid, ...req.body,
  }),
));

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

router.post('/orders/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  micro.transitionOrder({
    tenantId: tenantOf(req),
    id: req.params.id,
    finalised_by: req.user?.uid,
    ...req.body,
  }),
));

// Isolates
router.post('/orders/:id/isolates', requireStaffOrAdmin, wrap(async (req) =>
  micro.addIsolate({ tenantId: tenantOf(req), order_id: req.params.id, ...req.body }),
));

// Sensitivities
router.post('/isolates/:id/sensitivities', requireStaffOrAdmin, wrap(async (req) =>
  micro.addSensitivity({ tenantId: tenantOf(req), isolate_id: req.params.id, ...req.body }),
));

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
