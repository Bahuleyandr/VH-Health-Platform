import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as orderController from '../../controllers/pharmacy/orderController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import { sanitizePharmacyFields } from '../../middleware/sanitizeMiddleware.js';
import { validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
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
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs are allowed'));
    }
  }
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

// Pharmacist lifecycle actions
wrapAutoRBAC(router, 'pharmacyLifecycleRoutes', {
  get: [
    ['/:id/detail', [], pharmacyOrderController.getOrderDetail],
    // Dispense label / receipt for printing or in-app display. Available
    // once the order has been DISPENSED or DELIVERED. Wave-3 batch-1.
    ['/:id/label', [], pharmacyOrderController.getDispenseLabel],
    ['/:id/receipt', [], pharmacyOrderController.getDispenseLabel]
  ],
  post: [
    ['/:id/confirm', [], pharmacyOrderController.confirmOrder],
    ['/:id/preparing', [], pharmacyOrderController.markPreparing],
    ['/:id/dispatch', [], pharmacyOrderController.dispatchOrder],
    ['/:id/delivered', [], pharmacyOrderController.markDelivered],
    // B-2: counter-dispense — short-circuit lifecycle for walk-in customers.
    ['/:id/dispense-counter', [], pharmacyOrderController.markCounterDispensed],
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