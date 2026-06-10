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
  placeOrderValidation,
  updateOrderStatusValidation,
  getOrdersValidation,
  phoneParamValidation,
  uidParamValidation 
} from '../../validators/pharmacy/orderValidators.js';

const router = express.Router();

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

// Stage-4-C — GET /:id was previously shadowed by the legacy
// GET /:phone block below, so any integer path segment was
// misinterpreted as a phone number and returned {orders:[], phone:"5"}
// instead of the order. We can't use Express-style :id(\d+) in path
// strings under Express 5 / path-to-regexp v8, so we register /:id in
// the lifecycle block (declared before /:phone) and guard the handler:
// if the param isn't a plain integer (or LOOKS like a phone — 10+
// digits) it calls next('route') to fall through to the legacy
// /:phone matcher, preserving back-compat for patient-app callers
// still using phone-keyed lookups. Phone numbers in India are exactly
// 10 digits; pharmacy_orders.id is SERIAL — even at hospital scale we
// won't hit 9 digits (one billion orders), so the cutoff cleanly
// separates the two namespaces.
// Findings:
//   2026-05-09-walk-in-opd-pharmacy-order-route-shadowed
//   pharmacy-deep.test.js getOrdersByPhone — 9000040001 was being
//   matched as an order id under the original digits-only guard.
function orderIdGuard(req, res, next) {
  const param = req.params.id || '';
  if (!/^\d{1,9}$/.test(param)) return next('route');
  next();
}

// Pharmacist lifecycle actions
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  get: [
    // D57: documented/admin probes call GET /pharmacy/orders. Keep it as
    // a staff queue alias rather than falling through to the legacy :phone route.
    ['/', [], pharmacyOrderController.getOrderQueue],
    ['/:id/detail', [], pharmacyOrderController.getOrderDetail],
    ['/:id', [orderIdGuard], pharmacyOrderController.getOrderDetail],
    // Dispense label / receipt for printing or in-app display. Available
    // once the order has been DISPENSED or DELIVERED. Wave-3 batch-1.
    ['/:id/label', [], pharmacyOrderController.getDispenseLabel],
    ['/:id/receipt', [], pharmacyOrderController.getDispenseLabel],
    // B1 — med-pack barcode label (requires cleared clinical verification).
    ['/:id/pack-label', [], pharmacyVerificationController.getPharmacyPackLabel]
  ],
  post: [
    ['/:id/confirm', [], pharmacyOrderController.confirmOrder],
    // B1 — pharmacist clinical verification gate (before PREPARING/dispense).
    ['/:id/verify', [], pharmacyVerificationController.verifyPharmacyOrder],
    ['/:id/preparing', [], pharmacyOrderController.markPreparing],
    ['/:id/dispatch', [], pharmacyOrderController.dispatchOrder],
    ['/:id/delivered', [], pharmacyOrderController.markDelivered],
    // B-2: counter-dispense — short-circuit lifecycle for walk-in customers.
    ['/:id/dispense-counter', [], pharmacyOrderController.markCounterDispensed],
    // D57: documented short alias used by the swarm/client contract.
    ['/:id/dispense', [], pharmacyOrderController.markCounterDispensed],
    ['/:id/unavailable', [], pharmacyOrderController.markUnavailable],
    ['/:id/cancel', [], pharmacyOrderController.cancelOrder]
  ]
});

// ── Legacy routes (existing) ────────────────────────────────────────────────

// Patient routes
wrapAutoRBAC(router, 'pharmacyOrderRoutes', {
  post: [
    ['/', placeOrderValidation, sanitizePharmacyFields, orderController.placeOrder]
  ],
  
  get: [
    ['/uid/:uid', uidParamValidation, orderController.getOrdersByUID],
    ['/:phone', phoneParamValidation, getOrdersValidation, orderController.getOrdersByPhone]
  ]
});

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffOrderRoutes', {
  put: [
    ['/:orderId/status', updateOrderStatusValidation, orderController.updateOrderStatus]
  ]
});

export default router;
