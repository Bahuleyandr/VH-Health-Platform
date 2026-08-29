// src/routes/pharmacy/counterSaleRoutes.js
//
// Walk-in pharmacy point-of-sale (migration 684). Mounted at
// /api/v1/pharmacy-orders/counter-sales (and the /api/v1/pharmacy alias).
// Role gates mirror inventoryV2Routes: selling requires a dispensing role
// (PHARMACY_STAFF / PHARMACY_INCHARGE — Schedule X flows through the
// witnessed controlled-dispense path), voiding is incharge/admin-only, reads
// use the wider inventory-read roster.
//
// ★ ADMIN is deliberately NOT a seller. Every counter sale now resolves a
// canonical performer inside counterSaleService (resolveCounterSalePerformerTx),
// which accepts exactly {PHARMACY_STAFF, PHARMACY_INCHARGE} — the same set
// inventoryV2Service's CONTROLLED_DISPENSE_ROLES uses for the register
// performer it stamps. Leaving ADMIN on this gate would advertise an authority
// the service refuses with a 403 after the request is already in flight.
// ADMIN keeps its void authority and its read authority, and stays on the
// witness-approval host roster below.

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

export const COUNTER_SALE_SELL_ROLES = [PHARMACY_STAFF, PHARMACY_INCHARGE];
export const COUNTER_SALE_VOID_ROLES = [ADMIN, PHARMACY_INCHARGE];
export const COUNTER_SALE_READ_ROLES = [
  ADMIN, PHARMACY_STAFF, PHARMACY_INCHARGE, STORES_PURCHASE_INCHARGE,
];
// Pinned membership, deliberately NOT derived from the seller roster alone:
// app.js mounts this on both /counter-sales/witness-approvals/:id/approve
// paths, so narrowing who may SELL must not silently narrow who may CARRY an
// approval request. ADMIN is therefore listed explicitly, exactly as it was
// before ADMIN left COUNTER_SALE_SELL_ROLES. Hosting confers nothing on its
// own: the witness identity is proved server-side against
// CONTROLLED_DISPENSE_WITNESS_ROLES (controlledDispenseWitnessService.js:155),
// which does not contain ADMIN.
export const COUNTER_SALE_APPROVAL_HOST_ROLES = [
  ...new Set([ADMIN, ...COUNTER_SALE_SELL_ROLES, ...CONTROLLED_DISPENSE_WITNESS_ROLES]),
];

function wrap(handler, { status = 200 } = {}) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data, 'Success', status);
    } catch (err) {
      return relayAppError(res, err, 'Counter sale error');
    }
  };
}

export const COUNTER_SALE_IDEMPOTENCY_BASE = '/api/v1/pharmacy-orders/counter-sales';
const counterSaleMutationPath = (suffix = '') => `${COUNTER_SALE_IDEMPOTENCY_BASE}${suffix}`;
const canonicalMutationId = (value) => {
  const raw = String(value ?? '').trim();
  return /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, '') : raw;
};
const counterSaleIdMutationPath = (suffix) => (req) => (
  counterSaleMutationPath(`/${canonicalMutationId(req.params.id)}/${suffix}`)
);
const counterSaleWitnessApprovalPath = (req) => (
  counterSaleMutationPath(`/witness-approvals/${canonicalMutationId(req.params.id)}/approve`)
);

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

// The actor's OWN active pharmacy facility grants. The POS facility picker is
// fed from this instead of letting the client type an authority scope.
// Registered before '/:id' so the literal path is not eaten by the id route.
router.get('/facilities', requireRead, wrap(async (req) => ({
  facilities: await counterSales.listCounterSaleFacilities({
    tenantId: tenantOf(req),
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  }),
})));

// POS pick list: sellable items with usable stock + FEFO head batch/price.
// facility_id is a REQUEST, not authority: the service proves it against the
// actor's active grant before reading a single batch.
router.get('/items', requireRead, wrap(async (req) => ({
  items: await counterSales.searchSellableItems({
    tenantId: tenantOf(req),
    facilityId: req.query.facility_id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    search: req.query.q,
    limit: req.query.limit,
  }),
})));

// body.facility_id is a REQUEST, not authority: the service proves the actor's
// ACTIVE grant on it before it reads a single inventory row, so this surface
// cannot be used to enumerate another facility's catalogue. requested_by and
// requested_by_role are written AFTER the body spread on purpose — they are
// server-derived identity and a client-supplied value must never win.
router.post('/witness-approvals', requireSell, guardSaleBodyPatient, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_witness_request',
  retainOnServerError: true,
  requestPathForIdempotency: counterSaleMutationPath('/witness-approvals'),
}), wrap(async (req) => (
  counterSales.requestCounterSaleWitnessApproval({
    ...req.body,
    tenantId: tenantOf(req),
    requested_by: req.user?.uid,
    requested_by_role: req.user?.role || req.user?.rawRole || null,
  })
)));

pharmacyCounterSaleWitnessApprovalRoutes.post('/', requireApprovalHost, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_witness_approval',
  retainOnServerError: true,
  requestBodyForIdempotency: witnessApprovalIdempotencyBody,
  requestPathForIdempotency: counterSaleWitnessApprovalPath,
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
  requestPathForIdempotency: counterSaleMutationPath(),
}), wrap(async (req) => counterSales.createCounterSale({
  tenantId: tenantOf(req),
  facility_id: req.body.facility_id,
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
  request_id: req.id,
})));

// Scoped to the facilities the actor holds an ACTIVE grant for — tenant scope
// alone is not custody authority for a cross-facility POS ledger.
router.get('/', requireRead, wrap(async (req) => ({
  sales: await counterSales.listCounterSales({
    tenantId: tenantOf(req),
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    facilityId: req.query.facility_id,
    status: req.query.status,
    date: req.query.date,
    limit: req.query.limit,
  }),
})));

// ── The void surface ─────────────────────────────────────────────────
//
// ★ requireVoid is a ROLE gate, not custody. All four routes below therefore
// carry the caller's identity into the service, which resolves the sale's OWN
// facility from the stored row and asserts the actor's ACTIVE grant on it
// (assertCounterSaleFacilityCustodyTx). The read and the three mutations run
// the identical test — a mutation must never be weaker than the read of the
// same resource, and ADMIN sits on this roster without necessarily holding a
// grant anywhere. The mutations pass their actor through the existing
// voided_by / reconciled_by / resolved_by (+ _role) fields they already stamp
// on the evidence rows; do not add a route here without one.
router.get('/:id/void-status', requireVoid, guardSaleRowPatient, wrap(async (req) => (
  counterSales.getCounterSaleVoidStatus({
    tenantId: tenantOf(req),
    id: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  })
)));

router.get('/:id', requireRead, guardSaleRowPatient, wrap(async (req) => counterSales.getCounterSale({
  tenantId: tenantOf(req),
  id: req.params.id,
  actorUid: req.user?.uid,
  actorRole: req.user?.role,
})));

// Same-day initiation creates one dedicated pending refund. Pharmacy cannot
// approve or pay it, and stock stays untouched until exact paid-refund
// reconciliation closes the obligation.
router.post('/:id/void', requireVoid, guardSaleRowPatient, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_void',
  retainOnServerError: false,
  requestPathForIdempotency: counterSaleIdMutationPath('void'),
}), wrap(async (req) => counterSales.voidCounterSale({
  tenantId: tenantOf(req),
  id: req.params.id,
  reason: req.body.reason,
  disposition: req.body.disposition,
  voided_by: req.user?.uid,
  voided_by_name: req.user?.name || null,
  voided_by_role: req.user?.role || req.user?.rawRole || null,
  command_key: req.idempotencyClaim?.requestKey,
}), { status: 202 }));

router.post('/:id/void/reconcile', requireVoid, guardSaleRowPatient, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_counter_sale_void_reconcile',
  retainOnServerError: false,
  requestPathForIdempotency: counterSaleIdMutationPath('void/reconcile'),
}), wrap(async (req) => counterSales.reconcileCounterSaleVoid({
  tenantId: tenantOf(req),
  id: req.params.id,
  reconciled_by: req.user?.uid,
  reconciled_by_role: req.user?.role || req.user?.rawRole || null,
  request_id: req.id,
})));

router.post('/:id/void/rejection/resolve', requireVoid, guardSaleRowPatient,
  requireIdempotencyKey({
    required: true,
    scope: 'pharmacy_counter_sale_void_rejection_resolution',
    retainOnServerError: false,
    requestPathForIdempotency: counterSaleIdMutationPath('void/rejection/resolve'),
  }), wrap(async (req) => counterSales.resolveRejectedCounterSaleVoid({
    tenantId: tenantOf(req),
    id: req.params.id,
    resolution: req.body.resolution,
    reason: req.body.reason,
    resolved_by: req.user?.uid,
    resolved_by_role: req.user?.role || req.user?.rawRole || null,
    request_id: req.id,
  })));

export default router;
