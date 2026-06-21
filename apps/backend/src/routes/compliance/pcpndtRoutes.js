// src/routes/compliance/pcpndtRoutes.js — Sprint 18

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as pcpndt from '../../services/compliance/pcpndtService.js';
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
      logger.error('pcpndt route error:', err);
      return error(res, err.message || 'PCPNDT error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// Machines
router.get('/machines', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listMachines({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));
router.post('/machines', requireAdmin, wrap(async (req) =>
  pcpndt.upsertMachine({ tenantId: tenantOf(req), ...req.body }),
));

// Sonologists
router.get('/sonologists', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listSonologists({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));
router.post('/sonologists', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({ tenantId: tenantOf(req), ...req.body }),
));
router.patch('/sonologists/:id', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({
    tenantId: tenantOf(req), id: req.params.id, ...req.body,
  }),
));

// Form F
router.post('/form-f', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.createFormF({
    tenantId: tenantOf(req), created_by: req.user?.uid, ...req.body,
  }),
));
router.get('/form-f', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listFormF({
    tenantId: tenantOf(req),
    from: req.query.from,
    to: req.query.to,
    sonologist_id: req.query.sonologist_id,
    status: req.query.status,
    limit: req.query.limit,
  }),
));
router.get('/form-f/:id', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.getFormF({ tenantId: tenantOf(req), id: req.params.id }),
));

// Monthly submission rollup
router.post('/submissions/generate', requireAdmin, wrap(async (req) =>
  pcpndt.generateMonthlySubmission({
    tenantId: tenantOf(req),
    period_year: req.body.period_year,
    period_month: req.body.period_month,
    generated_by: req.user?.uid,
  }),
));
router.get('/submissions', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listSubmissions({
    tenantId: tenantOf(req), limit: req.query.limit,
  }),
));
router.post('/submissions/:id/acknowledge', requireAdmin, wrap(async (req) =>
  pcpndt.acknowledgeSubmission({
    tenantId: tenantOf(req), id: req.params.id,
    authority_reference: req.body.authority_reference,
    notes: req.body.notes,
  }),
));

export default router;
