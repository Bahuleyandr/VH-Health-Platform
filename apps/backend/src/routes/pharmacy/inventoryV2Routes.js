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
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
import { AppError } from '../../utils/AppError.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

const router = Router();
export const pharmacyInventoryWitnessApprovalRoutes = Router({ mergeParams: true });

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

export const PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES = [
  ...inv.CONTROLLED_DISPENSE_WITNESS_ROLES,
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

function requireControlledDispenseApprovalHost(req, res, next) {
  return requireInventoryRole(
    PHARMACY_CONTROLLED_DISPENSE_WITNESS_ROLES,
    'Clinical witness role required',
  )(req, res, next);
}

async function resolveWitnessActor(req, tenantId) {
  const employeeId = req.body?.employeeId;
  const password = req.body?.password;
  if (employeeId == null && password == null) {
    return { actorUid: req.user?.uid, requesterUid: null };
  }
  try {
    if (!employeeId || !password) {
      throw AppError.badRequest(
        'Witness employee ID and password are required together',
        'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_REQUIRED',
      );
    }
    const witness = await StaffAuthService.authenticateControlledDispenseWitness({
      employeeId,
      password,
      req,
      tenantId,
    });
    if (String(witness.tenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
      throw AppError.forbidden(
        'Witness authentication tenant mismatch',
        'CONTROLLED_DISPENSE_WITNESS_TENANT_MISMATCH',
      );
    }
    return { actorUid: witness.uid, requesterUid: req.user?.uid };
  } finally {
    if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
  }
}

function witnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    dispense: body.dispense || {},
  };
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
router.post('/controlled-dispense/witness-approvals', requireControlledDispense,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_witness_request',
    retainOnServerError: true,
  }),
  wrap(async (req) => inv.requestControlledDispenseWitnessApproval({
    ...req.body,
    tenantId: inv.tenantOf(req),
    requested_by: req.user?.uid,
  })));

pharmacyInventoryWitnessApprovalRoutes.post('/',
  requireControlledDispenseApprovalHost,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_inventory_witness_approval',
    retainOnServerError: true,
    requestBodyForIdempotency: witnessApprovalIdempotencyBody,
  }),
  wrap(async (req) => {
    const tenantId = inv.tenantOf(req);
    const actor = await resolveWitnessActor(req, tenantId);
    return inv.approveInventoryDispenseWitnessApproval({
      tenantId,
      approvalId: req.params.id,
      ...actor,
      dispense: req.body.dispense || {},
    });
  }));

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
