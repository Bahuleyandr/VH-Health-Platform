// src/routes/compliance/bmwAndDrugReturnRoutes.js — Sprint 20

import { Router } from 'express';
import * as bmw from '../../services/compliance/bmwService.js';
import * as drug from '../../services/compliance/drugReturnsService.js';
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
      return relayAppError(res, err, 'BMW / Drug returns error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── BMW ──────────────────────────────────────────────────────────────

router.post('/bmw/log', requireStaffOrAdmin, wrap(async (req) =>
  bmw.createWasteLog({
    ...req.body,
    tenantId: tenantOf(req), created_by: req.user?.uid,
  })));

router.get('/bmw/log', requireStaffOrAdmin, wrap(async (req) =>
  bmw.listWasteLogs({
    tenantId: tenantOf(req),
    from: req.query.from, to: req.query.to,
    source_dept: req.query.source_dept, limit: req.query.limit,
  })));

router.get('/bmw/monthly', requireStaffOrAdmin, wrap(async (req) =>
  bmw.monthlyRollup({ tenantId: tenantOf(req), year: req.query.year })));

router.get('/bmw/annual', requireStaffOrAdmin, wrap(async (req) =>
  bmw.annualSummary({ tenantId: tenantOf(req), year: req.query.year })));

// ── DRUG RETURNS ─────────────────────────────────────────────────────

router.post('/drug-returns/batches', requireStaffOrAdmin, wrap(async (req) =>
  drug.createBatch({
    ...req.body,
    tenantId: tenantOf(req), initiated_by: req.user?.uid,
  })));

router.get('/drug-returns/batches', requireStaffOrAdmin, wrap(async (req) =>
  drug.listBatches({
    tenantId: tenantOf(req),
    status: req.query.status, reason: req.query.reason,
    limit: req.query.limit,
  })));

router.get('/drug-returns/batches/:id', requireStaffOrAdmin, wrap(async (req) =>
  drug.getBatch({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/drug-returns/batches/:id/lines', requireStaffOrAdmin, wrap(async (req) =>
  drug.addLine({ ...req.body, tenantId: tenantOf(req), batch_id: req.params.id })));

router.post('/drug-returns/batches/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  drug.transition({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
    set_by: req.user?.uid,
  })));

export default router;
