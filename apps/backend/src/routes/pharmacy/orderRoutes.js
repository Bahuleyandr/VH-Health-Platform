import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as orderController from '../../controllers/pharmacy/orderController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import * as pharmacyVerificationController from '../../controllers/pharmacy/pharmacyVerificationController.js';
import { sanitizePharmacyFields } from '../../middleware/sanitizeMiddleware.js';
import { validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { prescriptionAttachmentFileFilter } from '../../utils/prescriptionAttachmentFilter.js';
import {
  pharmacyOrderGuard,
  selectOrderPatient,
  selectPatientByBodyPhone,
} from './pharmacyOrderPatientGuards.js';
import {
  placeOrderValidation,
  updateOrderStatusValidation,
  uidParamValidation
} from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

// Per-route patient access guards (see pharmacyOrderPatientGuards.js for why
// the mount-level guard never decided these path-keyed routes).
//
// Order-keyed routes do NOT force patient context: pharmacy_orders.patient_id
// is nullable and legacy rows may be phone-only, so a subject-less order must
// keep working on the role gate while every registered-patient order gets a
// real decision. /uid/:uid names its subject directly and DOES force context.
const guardOrderByIdParam = pharmacyOrderGuard(selectOrderPatient((req) => req.params?.id));
const guardOrderByOrderIdParam = pharmacyOrderGuard(selectOrderPatient((req) => req.params?.orderId));
const guardLegacyPlaceByPhone = pharmacyOrderGuard(selectPatientByBodyPhone);
const guardOrdersByPatientUid = pharmacyOrderGuard(
  (req) => (req.params?.uid ? { uid: req.params.uid } : null),
  { requirePatientContext: true },
);

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
    ['/my', [], pharmacyOrderController.getMyOrders],
    ['/queue', [], pharmacyOrderController.getOrderQueue],
    ['/sla', [], pharmacyOrderController.getPharmacySLADashboard]
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
    ['/:id/detail', [guardOrderByIdParam], pharmacyOrderController.getOrderDetail],
    // Patient + prescribed catalog_id lines behind an order — pharmacist substitution context.
    ['/:id/dispensable', [guardOrderByIdParam], pharmacyOrderController.getOrderDispensableContext],
    ['/:id', [guardOrderByIdParam], pharmacyOrderController.getOrderDetail],
    // Dispense label / receipt for printing or in-app display. Available
    // once the order has been DISPENSED or DELIVERED. Wave-3 batch-1.
    ['/:id/label', [guardOrderByIdParam], pharmacyOrderController.getDispenseLabel],
    ['/:id/receipt', [guardOrderByIdParam], pharmacyOrderController.getDispenseLabel],
    // B1 — med-pack barcode label (requires cleared clinical verification).
    ['/:id/pack-label', [guardOrderByIdParam], pharmacyVerificationController.getPharmacyPackLabel]
  ],
  post: [
    ['/:id/confirm', [guardOrderByIdParam], pharmacyOrderController.confirmOrder],
    // B1 — pharmacist clinical verification gate (before PREPARING/dispense).
    ['/:id/verify', [guardOrderByIdParam], pharmacyVerificationController.verifyPharmacyOrder],
    ['/:id/preparing', [guardOrderByIdParam], pharmacyOrderController.markPreparing],
    ['/:id/dispatch', [guardOrderByIdParam], pharmacyOrderController.dispatchOrder],
    ['/:id/delivered', [guardOrderByIdParam], pharmacyOrderController.markDelivered],
    // B-2: counter-dispense — short-circuit lifecycle for walk-in customers.
    ['/:id/dispense-counter', [guardOrderByIdParam], pharmacyOrderController.markCounterDispensed],
    // D57: documented short alias used by the swarm/client contract.
    ['/:id/dispense', [guardOrderByIdParam], pharmacyOrderController.markCounterDispensed],
    ['/:id/unavailable', [guardOrderByIdParam], pharmacyOrderController.markUnavailable],
    ['/:id/cancel', [guardOrderByIdParam], pharmacyOrderController.cancelOrder]
  ]
});

// ── Legacy routes (existing) ────────────────────────────────────────────────

// Patient routes. The legacy create resolves its target purely from
// body.phone — the guard resolves the same phone to the registered patient
// (an unregistered walk-in phone has no subject and stays role-gated).
wrapAutoRBAC(router, 'pharmacyOrderRoutes', {
  post: [
    ['/', placeOrderValidation, sanitizePharmacyFields, guardLegacyPlaceByPhone, orderController.placeOrder]
  ],

  get: [
    ['/uid/:uid', uidParamValidation, guardOrdersByPatientUid, orderController.getOrdersByUID]
  ]
});

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffOrderRoutes', {
  put: [
    ['/:orderId/status', updateOrderStatusValidation, guardOrderByOrderIdParam, orderController.updateOrderStatus]
  ]
});

export default router;
