// src/routes/pharmacy/counterSaleRoutes.js
//
// Walk-in pharmacy point-of-sale (migration 684). Mounted at
// /api/v1/pharmacy-orders/counter-sales (and the /api/v1/pharmacy alias).
// Role gates mirror inventoryV2Routes: selling requires a dispensing role
// (ADMIN / PHARMACY_STAFF / PHARMACY_INCHARGE — Schedule X flows through the
// witnessed controlled-dispense path), voiding is incharge/admin-only, reads
// use the wider inventory-read roster.

import { Router } from 'express';
import * as counterSales from '../../services/pharmacy/counterSaleService.js';
import { tenantOf } from '../../services/pharmacy/inventoryV2Service.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  ADMIN,
  PHARMACY_INCHARGE,
  PHARMACY_STAFF,
  STORES_PURCHASE_INCHARGE,
  hasRole,
} from '../../utils/roles.js';
import { CONTROLLED_DISPENSE_WITNESS_ROLES } from '../../services/pharmacy/controlledDispenseWitnessService.js';
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
import { AppError } from '../../utils/AppError.js';
import {
  pharmacyOrderGuard,
  selectCounterSalePatient,
  selectPatientFromBodyUid,
} from './pharmacyOrderPatientGuards.js';

const router = Router();
export const pharmacyCounterSaleWitnessApprovalRoutes = Router({ mergeParams: true });

// Per-route patient access guards (see pharmacyOrderPatientGuards.js). A
// counter sale is anonymous-by-design unless a registered patient is
// attached, so none of these force patient context: the guard decides when
// body.patient_uid (create/witness request) or the stored sale row (:id
// read/void) names a registered patient, and stays out of the way of
// anonymous walk-in sales.
const guardSaleBodyPatient = pharmacyOrderGuard(selectPatientFromBodyUid);
const guardSaleRowPatient = pharmacyOrderGuard(selectCounterSalePatient);

export const COUNTER_SALE_SELL_ROLES = [ADMIN, PHARMACY_STAFF, PHARMACY_INCHARGE];
export const COUNTER_SALE_VOID_ROLES = [ADMIN, PHARMACY_INCHARGE];
export const COUNTER_SALE_READ_ROLES = [
  ADMIN, PHARMACY_STAFF, PHARMACY_INCHARGE, STORES_PURCHASE_INCHARGE,
];
export const COUNTER_SALE_APPROVAL_HOST_ROLES = [
  ...new Set([...COUNTER_SALE_SELL_ROLES, ...CONTROLLED_DISPENSE_WITNESS_ROLES]),
];

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Counter sale error');
    }
  };
}

function requireCounterSaleRole(allowedRoles, message) {
  return (req, res, next) => {
    if (!hasRole(req.user, allowedRoles) && !hasRole(req.user?.rawRole, allowedRoles)) {
      return error(res, message, 403);
    }
    return next();
  };
}

const requireSell = requireCounterSaleRole(
  COUNTER_SALE_SELL_ROLES, 'Pharmacy dispensing role required',
);
const requireVoid = requireCounterSaleRole(
  COUNTER_SALE_VOID_ROLES, 'Pharmacy incharge role required',
);
const requireRead = requireCounterSaleRole(
  COUNTER_SALE_READ_ROLES, 'Pharmacy role required',
);
const requireApprovalHost = requireCounterSaleRole(
  COUNTER_SALE_APPROVAL_HOST_ROLES,
  'Pharmacy seller or clinical witness role required',
);

function witnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    sale: body.sale || {},
  };
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

// POS pick list: sellable items with usable stock + FEFO head batch/price.
router.get('/items', requireRead, wrap(async (req) => ({
  items: await counterSales.searchSellableItems({
    tenantId: tenantOf(req),
    search: req.query.q,
    limit: req.query.limit,
  }),
})));

router.post('/witness-approvals', requireSell, guardSaleBodyPatient, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_witness_request',
  retainOnServerError: true,
}), wrap(async (req) => (
  counterSales.requestCounterSaleWitnessApproval({
    ...req.body,
    tenantId: tenantOf(req),
    requested_by: req.user?.uid,
  })
)));

pharmacyCounterSaleWitnessApprovalRoutes.post('/', requireApprovalHost, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_witness_approval',
  retainOnServerError: true,
  requestBodyForIdempotency: witnessApprovalIdempotencyBody,
}), wrap(async (req) => {
  const tenantId = tenantOf(req);
  const actor = await resolveWitnessActor(req, tenantId);
  return counterSales.approveCounterSaleWitnessApproval({
    approvalId: req.params.id,
    ...actor,
    sale: {
      ...(req.body.sale || {}),
      tenantId,
    },
  });
}));

// Sell: FEFO dispense + schedule enforcement + PHARMACY invoice + payment.
//
// Idempotency-Key is REQUIRED (billingV2 /payments convention): the shared
// Flutter transport auto-mints the header and replays the identical body up
// to 3x on timeout/socket-drop/5xx, and this handler moves stock AND money in
// one shot — an unguarded replay is a second dispense + second charge. The
// durable idempotency_keys claim (unique on tenant/user/key/path) makes a
// replay return the cached original sale and a concurrent duplicate a 409,
// never a second sale.
router.post('/', requireSell, guardSaleBodyPatient, requireIdempotencyKey({
  // retainOnServerError: this handler commits stock, money and the statutory
  // register, then assembles its response — a 5xx here does NOT mean "nothing
  // happened". Releasing the claim would let the transport's automatic replay
  // dispense and charge a second time.
  required: true, scope: 'pharmacy_counter_sale', retainOnServerError: true,
}), wrap(async (req) => counterSales.createCounterSale({
  tenantId: tenantOf(req),
  lines: req.body.lines,
  patient_uid: req.body.patient_uid,
  customer_name: req.body.customer_name,
  customer_phone: req.body.customer_phone,
  rx: req.body.rx,
  witness_approval_id: req.body.witness_approval_id,
  payment_mode: req.body.payment_mode,
  payment_reference: req.body.payment_reference,
  notes: req.body.notes,
  sold_by: req.user?.uid,
  sold_by_name: req.body.sold_by_name || req.user?.name || null,
  request_id: req.id,
})));

router.get('/', requireRead, wrap(async (req) => ({
  sales: await counterSales.listCounterSales({
    tenantId: tenantOf(req),
    status: req.query.status,
    date: req.query.date,
    limit: req.query.limit,
  }),
})));

router.get('/:id', requireRead, guardSaleRowPatient, wrap(async (req) => counterSales.getCounterSale({
  tenantId: tenantOf(req),
  id: req.params.id,
})));

// Same-day void: billing refund + exact per-batch restock (controlled lines
// re-enter the statutory register in the return direction). Idempotency-Key
// required for the same reason as the sale: a void moves money (refund) and
// stock (restock); a transport replay must return the original void result,
// not race a second attempt.
router.post('/:id/void', requireVoid, guardSaleRowPatient, requireIdempotencyKey({
  // Same reasoning as the sale: a void moves money (refund) and stock
  // (restock), so a post-commit 5xx must not be replayed into a second void.
  required: true, scope: 'pharmacy_counter_sale_void', retainOnServerError: true,
}), wrap(async (req) => counterSales.voidCounterSale({
  tenantId: tenantOf(req),
  id: req.params.id,
  reason: req.body.reason,
  voided_by: req.user?.uid,
  voided_by_name: req.body.voided_by_name || req.user?.name || null,
  request_id: req.id,
})));

export default router;
