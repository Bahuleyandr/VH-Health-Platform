// src/routes/pharmacy/inventoryV2Routes.js
//
// Sprint 2 — Pharmacy operational inventory endpoints. Mounted at
// /api/v1/pharmacy/inventory/v2/*. The legacy inventoryRoutes.js
// remains for back-compat (it exposes /categories/list).

import { Router } from 'express';
import * as inv from '../../services/pharmacy/inventoryV2Service.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  ADMIN,
  PHARMACY_INCHARGE,
  PHARMACY_STAFF,
  STORES_PURCHASE_INCHARGE,
  hasRole,
} from '../../utils/roles.js';

const router = Router();

export const PHARMACY_INVENTORY_READ_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  STORES_PURCHASE_INCHARGE,
];

export const PHARMACY_INVENTORY_MAINTAIN_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
  STORES_PURCHASE_INCHARGE,
];

export const PHARMACY_INVENTORY_ADMIN_ROLES = [
  ADMIN,
  PHARMACY_INCHARGE,
  STORES_PURCHASE_INCHARGE,
];

export const PHARMACY_CONTROLLED_DISPENSE_ROLES = [
  ADMIN,
  PHARMACY_STAFF,
  PHARMACY_INCHARGE,
];

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Inventory error');
    }
  };
}

function requireInventoryRole(allowedRoles, message) {
  return (req, res, next) => {
    if (!hasRole(req.user, allowedRoles) && !hasRole(req.user?.rawRole, allowedRoles)) {
      return error(res, message, 403);
    }
    return next();
  };
}

function requireInventoryRead(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_READ_ROLES,
    'Pharmacy inventory role required',
  )(req, res, next);
}

function requireInventoryMaintain(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_MAINTAIN_ROLES,
    'Pharmacy inventory maintenance role required',
  )(req, res, next);
}

function requireInventoryAdmin(req, res, next) {
  return requireInventoryRole(
    PHARMACY_INVENTORY_ADMIN_ROLES,
    'Pharmacy incharge or stores/purchase role required',
  )(req, res, next);
}

function requireControlledDispense(req, res, next) {
  return requireInventoryRole(
    PHARMACY_CONTROLLED_DISPENSE_ROLES,
    'Pharmacy dispensing role required',
  )(req, res, next);
}

// ── Drug master / items ───────────────────────────────────────────────
router.get('/items', requireInventoryRead, wrap(async (req) => inv.listItems({
  tenantId: inv.tenantOf(req),
  search: req.query.q,
  schedule: req.query.schedule,
  status: req.query.status,
  limit: req.query.limit,
})));

router.post('/items', requireInventoryAdmin, wrap(async (req) => inv.createItem({
  tenantId: inv.tenantOf(req),
  item: req.body,
})));

// ── Batches ───────────────────────────────────────────────────────────
router.get('/batches', requireInventoryRead, wrap(async (req) => inv.listBatches({
  tenantId: inv.tenantOf(req),
  item_id: req.query.item_id,
  expiring_in_days: req.query.expiring_in_days,
  status: req.query.status,
  limit: req.query.limit,
})));

// ── Stock movements ───────────────────────────────────────────────────
router.post('/movements', requireInventoryMaintain, wrap(async (req) => inv.recordMovement({
  ...req.body,
  tenantId: inv.tenantOf(req),
  performed_by: req.user?.uid,
})));

// ── Schedule H/H1/X register ──────────────────────────────────────────
router.post('/controlled-dispense', requireControlledDispense, wrap(async (req) => inv.dispenseControlled({
  ...req.body,
  tenantId: inv.tenantOf(req),
  performed_by: req.user?.uid,
  performed_by_name: req.body.performed_by_name || req.user?.name || null,
})));

router.get('/schedule-register', requireInventoryRead, wrap(async (req) => inv.listScheduleRegister({
  tenantId: inv.tenantOf(req),
  schedule_class: req.query.schedule_class,
  item_id: req.query.item_id,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  limit: req.query.limit,
})));

// ── Expiry scan ───────────────────────────────────────────────────────
router.post('/run-expiry-scan', requireInventoryAdmin, wrap(async (req) =>
  inv.runExpiryScan({ tenantId: inv.tenantOf(req) }),
));

router.get('/expiry-alerts', requireInventoryRead, wrap(async (req) => inv.listExpiryAlerts({
  tenantId: inv.tenantOf(req),
  bucket: req.query.bucket,
  limit: req.query.limit,
})));

export default router;
