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

// The legacy phone-keyed lookup (GET /:phone) was removed (phone-in-URL PHI;
// no live caller — patient app uses /orders/my + /orders/uid/:uid), so the
// digit-count orderIdGuard that existed only to fall through to it is gone too.
// GET /:id now handles every single-segment id directly.

// Pharmacist lifecycle actions
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  get: [
    // D57: documented/admin probes call GET /pharmacy/orders. Keep it as
    // a staff queue alias rather than falling through to the legacy :phone route.
    ['/', [], pharmacyOrderController.getOrderQueue],
    ['/:id/detail', [], pharmacyOrderController.getOrderDetail],
    ['/:id', [], pharmacyOrderController.getOrderDetail],
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
    ['/uid/:uid', uidParamValidation, orderController.getOrdersByUID]
  ]
});

// Pharmacy staff routes
wrapAutoRBAC(router, 'pharmacyStaffOrderRoutes', {
  put: [
    ['/:orderId/status', updateOrderStatusValidation, orderController.updateOrderStatus]
  ]
});

export default router;
