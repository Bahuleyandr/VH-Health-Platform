// src/routes/compliance/bmwAndDrugReturnRoutes.js — Sprint 20

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as bmw from '../../services/compliance/bmwService.js';
import * as drug from '../../services/compliance/drugReturnsService.js';
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
      logger.error('bmw/drug-returns route error:', err);
      return error(res, err.message || 'BMW / Drug returns error', 500);
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
    tenantId: tenantOf(req), created_by: req.user?.uid, ...req.body,
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
    tenantId: tenantOf(req), initiated_by: req.user?.uid, ...req.body,
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
  drug.addLine({ tenantId: tenantOf(req), batch_id: req.params.id, ...req.body })));

router.post('/drug-returns/batches/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  drug.transition({
    tenantId: tenantOf(req), id: req.params.id,
    set_by: req.user?.uid,
    ...req.body,
  })));

export default router;
