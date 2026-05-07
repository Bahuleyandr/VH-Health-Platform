// src/routes/pharmacy/inventoryV2Routes.js
//
// Sprint 2 — Pharmacy operational inventory endpoints. Mounted at
// /api/v1/pharmacy/inventory/v2/*. The legacy inventoryRoutes.js
// remains for back-compat (it exposes /categories/list).

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as inv from '../../services/pharmacy/inventoryV2Service.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('inventoryV2 route error:', err);
      return error(res, err.message || 'Inventory error', 500);
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

// ── Drug master / items ───────────────────────────────────────────────
router.get('/items', requireStaffOrAdmin, wrap(async (req) => inv.listItems({
  tenantId: inv.tenantOf(req),
  search: req.query.q,
  schedule: req.query.schedule,
  status: req.query.status,
  limit: req.query.limit,
})));

router.post('/items', requireAdmin, wrap(async (req) => inv.createItem({
  tenantId: inv.tenantOf(req),
  item: req.body,
})));

// ── Batches ───────────────────────────────────────────────────────────
router.get('/batches', requireStaffOrAdmin, wrap(async (req) => inv.listBatches({
  tenantId: inv.tenantOf(req),
  item_id: req.query.item_id,
  expiring_in_days: req.query.expiring_in_days,
  status: req.query.status,
  limit: req.query.limit,
})));

// ── Stock movements ───────────────────────────────────────────────────
router.post('/movements', requireStaffOrAdmin, wrap(async (req) => inv.recordMovement({
  tenantId: inv.tenantOf(req),
  ...req.body,
  performed_by: req.user?.uid,
})));

// ── Schedule H/H1/X register ──────────────────────────────────────────
router.post('/controlled-dispense', requireStaffOrAdmin, wrap(async (req) => inv.dispenseControlled({
  tenantId: inv.tenantOf(req),
  ...req.body,
  performed_by: req.user?.uid,
  performed_by_name: req.body.performed_by_name || req.user?.name || null,
})));

router.get('/schedule-register', requireStaffOrAdmin, wrap(async (req) => inv.listScheduleRegister({
  tenantId: inv.tenantOf(req),
  schedule_class: req.query.schedule_class,
  item_id: req.query.item_id,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  limit: req.query.limit,
})));

// ── Expiry scan ───────────────────────────────────────────────────────
router.post('/run-expiry-scan', requireAdmin, wrap(async (req) =>
  inv.runExpiryScan({ tenantId: inv.tenantOf(req) }),
));

router.get('/expiry-alerts', requireStaffOrAdmin, wrap(async (req) => inv.listExpiryAlerts({
  tenantId: inv.tenantOf(req),
  bucket: req.query.bucket,
  limit: req.query.limit,
})));

export default router;
