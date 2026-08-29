import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as orderController from '../../controllers/pharmacy/orderController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import * as pharmacyVerificationController from '../../controllers/pharmacy/pharmacyVerificationController.js';
import { sanitizePharmacyFields } from '../../middleware/sanitizeMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { PG_INT4_MAX } from '../../middleware/routePatientAccessGuards.js';
import { validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { prescriptionAttachmentFileFilter } from '../../utils/prescriptionAttachmentFilter.js';
import {
  pharmacyOrderGuard,
  selectOrderPatient,
} from './pharmacyOrderPatientGuards.js';
import { uidParamValidation } from '../../validators/pharmacy/orderValidators.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

// ── Delivery custody surfaces ───────────────────────────────────────────────
// These are mounted in app.js at their own EXACT full paths, each with its own
// mount-level requireRole — the same shape as the pharmacy witness-approval
// routers (counterSaleRoutes.js, dispenseSubstitutionWitnessRoutes.js). That is
// why each router below declares a single '/' route and reads :id through
// mergeParams: an exact mount strips the whole matched path, and a prefix mount
// on `/api/v1/pharmacy-orders/orders` would sit over the ENTIRE order lifecycle
// and re-run the broad mount's rate limiter and phiAccessLogger on every
// fall-through request.
export const PHARMACY_DELIVERY_ASSIGNED_ROLES = ['DELIVERY_STAFF'];
export const PHARMACY_DELIVERY_CUSTODY_ROLES = ['DELIVERY_STAFF', 'PHARMACY_INCHARGE'];
export const PHARMACY_DELIVERY_INCHARGE_ROLES = ['PHARMACY_INCHARGE'];

export const pharmacyAssignedDeliveryRoutes = express.Router({ mergeParams: true });
pharmacyAssignedDeliveryRoutes.get(
  '/',
  requireRole(...PHARMACY_DELIVERY_ASSIGNED_ROLES),
  pharmacyOrderController.getAssignedDeliveries,
);

// Per-route patient access guards (see pharmacyOrderPatientGuards.js for why
// the mount-level guard never decided these path-keyed routes).
//
// Order-keyed routes do NOT force patient context: pharmacy_orders.patient_id
// is nullable and legacy rows may be phone-only, so a subject-less order must
// keep working on the role gate while every registered-patient order gets a
// real decision. /uid/:uid names its subject directly and DOES force context.
const guardOrderByIdParam = pharmacyOrderGuard(
  selectOrderPatient((req) => req.params?.id),
  { requirePatientContext: true },
);
const guardOrdersByPatientUid = pharmacyOrderGuard(
  (req) => (req.params?.uid ? { uid: req.params.uid } : null),
  { requirePatientContext: true },
);
const canonicalOrderDispenseBody = (req) => {
  const body = { ...(req.body || {}) };
  delete body.order_id;
  delete body.orderId;
  delete body.id;
  return body;
};
const orderDispenseIdempotency = (action) => requireIdempotencyKey({
  required: true,
  scope: `pharmacy-order-${action}`,
  retainOnServerError: true,
  durableDomainReceipt: true,
  requestPathForIdempotency: (req) =>
    `/api/v1/pharmacy-orders/orders/${req.params.id}/${action}`,
  requestBodyForIdempotency: canonicalOrderDispenseBody,
});
const counterDispenseIdempotency = orderDispenseIdempotency('dispense');

// Multer for prescription photo upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: prescriptionAttachmentFileFilter
});

// ── New lifecycle routes (static paths BEFORE :id) ──────────────────────────

// Patient: place order with prescription photo
wrapAutoRBAC(router, 'pharmacyPatientOrderRoutes', {
  post: [
    ['/place', [upload.single('prescription'), validateFileContent, validatePatientUpload, sanitizePharmacyFields], pharmacyOrderController.placeOrder]
  ],
  get: [
    ['/my', [], pharmacyOrderController.getMyOrders]
  ]
});

// The legacy phone-keyed lookup (GET /:phone) was removed (phone-in-URL PHI;
// no live caller — patient app uses /orders/my + /orders/uid/:uid), so the
// digit-count orderIdGuard that existed only to fall through to it is gone too.
// GET /:id now handles every single-segment id directly.

// Pharmacist lifecycle actions
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  get: [
    // D57: documented/admin probes call GET /pharmacy/orders. Keep it as
    // a staff queue alias rather than falling through to the legacy :phone route.
    // Cross-patient staff queue — no single subject, so no patient guard.
    ['/', [], pharmacyOrderController.getOrderQueue],
    ['/queue', [], pharmacyOrderController.getOrderQueue],
    ['/sla', [], pharmacyOrderController.getPharmacySLADashboard],
    ['/:id/detail', [guardOrderByIdParam], pharmacyOrderController.getOrderDetail],
    // Patient + prescribed catalog_id lines behind an order — pharmacist substitution context.
    ['/:id/dispensable', [guardOrderByIdParam], pharmacyOrderController.getOrderDispensableContext],
    ['/:id/delivery-assignees', [guardOrderByIdParam], pharmacyOrderController.getDeliveryAssignees],
    ['/:id', [guardOrderByIdParam], pharmacyOrderController.getOrderDetail],
    // Dispense label / receipt for printing or in-app display. Available
    // once the order has been DISPENSED or DELIVERED. Wave-3 batch-1.
    ['/:id/label', [guardOrderByIdParam], pharmacyOrderController.getDispenseLabel],
    ['/:id/receipt', [guardOrderByIdParam], pharmacyOrderController.getDispenseLabel],
    // B1 — med-pack barcode label (requires cleared clinical verification).
    ['/:id/pack-label', [guardOrderByIdParam], pharmacyVerificationController.getPharmacyPackLabel]
  ],
  post: [
    ['/:id/confirm', [guardOrderByIdParam, orderDispenseIdempotency('confirm')], pharmacyOrderController.confirmOrder],
    // B1 — pharmacist clinical verification gate (before PREPARING/dispense).
    ['/:id/verify', [guardOrderByIdParam, orderDispenseIdempotency('verify')], pharmacyVerificationController.verifyPharmacyOrder],
    ['/:id/assign-facility', [guardOrderByIdParam, orderDispenseIdempotency('assign-facility')], pharmacyOrderController.assignOrderFacility],
    ['/:id/resolve-line-identities', [guardOrderByIdParam, orderDispenseIdempotency('resolve-line-identities')], pharmacyOrderController.resolveOrderLineIdentities],
    ['/:id/preparing', [guardOrderByIdParam, orderDispenseIdempotency('preparing')], pharmacyOrderController.markPreparing],
    ['/:id/dispatch', [guardOrderByIdParam, orderDispenseIdempotency('dispatch')], pharmacyOrderController.dispatchOrder],
    // B-2: counter-dispense — short-circuit lifecycle for walk-in customers.
    ['/:id/dispense-counter', [guardOrderByIdParam, counterDispenseIdempotency], pharmacyOrderController.markCounterDispensed],
    // D57: documented short alias used by the swarm/client contract.
    ['/:id/dispense', [guardOrderByIdParam, counterDispenseIdempotency], pharmacyOrderController.markCounterDispensed],
    ['/:id/unavailable', [guardOrderByIdParam, orderDispenseIdempotency('unavailable')], pharmacyOrderController.markUnavailable],
    ['/:id/cancel', [guardOrderByIdParam, orderDispenseIdempotency('cancel')], pharmacyOrderController.cancelOrder]
  ]
});

// The id bound is common to ALL FOUR delivery-custody surfaces, so it lives in
// its own function rather than inside the custody predicate below.
//
// An id that cannot name a row is a miss, not an engine failure — same refusal
// as the empty custody result further down (see the AppError note there).
//
// The int4 ceiling is load-bearing, not belt-and-braces. Everything downstream
// binds this value as `::int` — the custody predicate's `orders.id=$2::int`,
// findOrderCommandReplay's `pharmacy_order_id=$2::int`, and each command's own
// order lookup — so an id that is a safe positive integer but above
// PG_INT4_MAX (e.g. 9999999999) would reach the bind and raise Postgres 22003
// 'integer out of range': a plain Prisma error with no statusCode, which
// errorHandlerMiddleware answers 500 with no code. The controllers' own
// `!Number.isSafeInteger(orderId) || orderId <= 0` test carries no ceiling, so
// the bound has to hold here, at the route layer, before any controller code
// runs. Same rule as positiveIntOrNull in
// middleware/routePatientAccessGuards.js ('an out-of-range value must become
// null, never a 22003 from the bind') and as this router's own
// selectOrderPatient id guard.
function boundDeliveryOrderId(req) {
  const orderId = Number(req.params?.id);
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || orderId > PG_INT4_MAX) {
    throw AppError.notFound(
      'Delivery custody not found',
      'PHARMACY_DELIVERY_CUSTODY_NOT_FOUND',
    );
  }
  return orderId;
}

// The id bound alone, for the two PHARMACY_INCHARGE-only surfaces (handoff
// reissue, return completion). They deliberately do NOT run the custody
// predicate below: it demands `delivery_custody_status='in_transit'`, which is
// the wrong state for return completion (`return_pending`), and
// unit/pharmacyMountRouteGuards.test.js pins that neither surface ever queries
// it. The bound is the half they DO share — same check, same refusal, one
// mechanism.
function requireBoundDeliveryOrderId(req, _res, next) {
  try {
    boundDeliveryOrderId(req);
    next();
  } catch (error) {
    next(error);
  }
}

async function requireExactDeliveryCustody(req, _res, next) {
  try {
    const orderId = boundDeliveryOrderId(req);
    const tenantId = req.tenantId || req.user?.tenantId || req.user?.tenant_id;
    const actorUid = String(req.user?.uid || '').trim();
    const actorRole = String(req.user?.role || '').trim().toUpperCase();
    // Missing tenant/actor context is an environment failure, not a miss:
    // keep failing closed with a 500 rather than reporting "not found".
    if (!tenantId || !actorUid) {
      throw new Error('delivery custody context unavailable');
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT orders.id
         FROM pharmacy_orders orders
         JOIN pharmacy_staff_facility_grants facility_grant
           ON facility_grant.tenant_id=orders.tenant_id
          AND facility_grant.facility_id=orders.facility_id
          AND facility_grant.staff_uid=$3::uuid
          AND facility_grant.status='active'
          AND facility_grant.revoked_at IS NULL
        WHERE orders.tenant_id=$1::uuid AND orders.id=$2::int
          AND orders.status='DISPATCHED'
          AND orders.delivery_custody_status='in_transit'
          AND orders.delivery_handoff_consumed_at IS NULL
          AND (
            (orders.delivery_assignee_uid=$3::uuid AND $4='DELIVERY_STAFF')
            OR $4='PHARMACY_INCHARGE'
          )
        LIMIT 1`,
      tenantId,
      orderId,
      actorUid,
      actorRole,
    );
    if (!rows[0]) {
      // AppError, not a hand-stamped Error: errorHandlerMiddleware reads
      // `err.statusCode` (never `err.status`) and only emits `code` on the
      // AppError branch, so a plain Error answered 500 with no code here.
      throw AppError.notFound(
        'Delivery custody not found',
        'PHARMACY_DELIVERY_CUSTODY_NOT_FOUND',
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}

// One router per exact mount path (see the delivery-custody note above the
// assigned-deliveries router). :id arrives from the app.js mount path through
// mergeParams, so orderDispenseIdempotency, requireExactDeliveryCustody and the
// controllers all read req.params.id exactly as before.
export const pharmacyDeliveryCompletionRoutes = express.Router({ mergeParams: true });
pharmacyDeliveryCompletionRoutes.post(
  '/',
  requireRole(...PHARMACY_DELIVERY_CUSTODY_ROLES),
  requireExactDeliveryCustody,
  orderDispenseIdempotency('delivered'),
  pharmacyOrderController.markDelivered,
);

export const pharmacyDeliveryHandoffReissueRoutes = express.Router({ mergeParams: true });
pharmacyDeliveryHandoffReissueRoutes.post(
  '/',
  requireRole(...PHARMACY_DELIVERY_INCHARGE_ROLES),
  requireBoundDeliveryOrderId,
  orderDispenseIdempotency('delivery-handoff-reissue'),
  pharmacyOrderController.reissueDeliveryHandoff,
);

export const pharmacyDeliveryReturnRequestRoutes = express.Router({ mergeParams: true });
pharmacyDeliveryReturnRequestRoutes.post(
  '/',
  requireRole(...PHARMACY_DELIVERY_CUSTODY_ROLES),
  requireExactDeliveryCustody,
  orderDispenseIdempotency('delivery-return-request'),
  pharmacyOrderController.requestDeliveryReturn,
);

export const pharmacyDeliveryReturnCompletionRoutes = express.Router({ mergeParams: true });
pharmacyDeliveryReturnCompletionRoutes.post(
  '/',
  requireRole(...PHARMACY_DELIVERY_INCHARGE_ROLES),
  requireBoundDeliveryOrderId,
  orderDispenseIdempotency('delivery-return-complete'),
  pharmacyOrderController.completeDeliveryReturn,
);

// ── Legacy routes (existing) ────────────────────────────────────────────────

// Read-only legacy patient lookup remains for existing clients. Legacy create
// and generic status mutation were retired: both bypassed the facility-bound,
// verified Inventory V2 lifecycle above.
wrapAutoRBAC(router, 'pharmacyOrderRoutes', {
  get: [
    ['/uid/:uid', uidParamValidation, guardOrdersByPatientUid, orderController.getOrdersByUID]
  ]
});

export default router;
