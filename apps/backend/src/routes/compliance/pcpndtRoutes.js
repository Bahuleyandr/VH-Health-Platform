// src/routes/compliance/pcpndtRoutes.js — Sprint 18

import { Router } from 'express';
import * as pcpndt from '../../services/compliance/pcpndtService.js';
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
      // Shared relay (responseHelper.relayAppError): surfaces AppError
      // code+details per the documented envelope; non-AppErrors get a logged
      // generic 500 that never relays raw err.message.
      return relayAppError(res, err, 'PCPNDT error');
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
  pcpndt.upsertMachine({ ...req.body, tenantId: tenantOf(req) }),
));

// Sonologists
router.get('/sonologists', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.listSonologists({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));
router.post('/sonologists', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({ ...req.body, tenantId: tenantOf(req) }),
));
router.patch('/sonologists/:id', requireAdmin, wrap(async (req) =>
  pcpndt.upsertSonologist({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
  }),
));

// Form F
router.post('/form-f', requireStaffOrAdmin, wrap(async (req) =>
  pcpndt.createFormF({
    ...req.body,
    tenantId: tenantOf(req), created_by: req.user?.uid,
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
