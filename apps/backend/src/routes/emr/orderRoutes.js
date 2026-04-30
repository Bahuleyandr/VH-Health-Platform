// src/routes/emr/orderRoutes.js
import express from 'express';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import * as orderEntryService from '../../services/emr/orderEntryService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// ===================================================================
// POST /emr/orders — Create a clinical order
// ===================================================================

router.post('/orders', requireIdempotencyKey({ required: false, scope: 'clinical_order' }), async (req, res, next) => {
  try {
    const { encounter_id, patient_uid, order_type, priority, details, start_date, end_date, notes } = req.body;

    if (!patient_uid || !order_type || !details) {
      return error(res, 'patient_uid, order_type, and details are required', 400);
    }

    const result = await orderEntryService.createOrder({
      encounter_id: encounter_id || null,
      patient_uid,
      order_type,
      priority,
      details,
      ordered_by: req.user.uid,
      start_date,
      end_date,
      notes,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: `clinical_order:${order_type}`,
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Order created', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/orders/apply-set — Apply an order set
// ===================================================================

router.post('/orders/apply-set', async (req, res, next) => {
  try {
    const { patient_uid, encounter_id, order_set_id } = req.body;

    if (!patient_uid || !order_set_id) {
      return error(res, 'patient_uid and order_set_id are required', 400);
    }

    const result = await orderEntryService.applyOrderSet(
      patient_uid,
      encounter_id || null,
      order_set_id,
      req.user.uid
    );

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: 'clinical_order:order_set',
      action: 'CREATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Order set applied', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/verify — Verify an order
// ===================================================================

router.put('/orders/:id/verify', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    const result = await orderEntryService.verifyOrder(orderId, req.user.uid);
    return success(res, result, 'Order verified');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/complete — Complete an order
// ===================================================================

router.put('/orders/:id/complete', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    const result = await orderEntryService.completeOrder(orderId, req.user.uid);
    return success(res, result, 'Order completed');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/cancel — Cancel an order
// ===================================================================

router.put('/orders/:id/cancel', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    if (!reason) {
      return error(res, 'Cancellation reason is required', 400);
    }

    const result = await orderEntryService.cancelOrder(orderId, req.user.uid, reason);
    return success(res, result, 'Order cancelled');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/discontinue — Discontinue an order
// ===================================================================

router.put('/orders/:id/discontinue', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    if (!reason) {
      return error(res, 'Discontinuation reason is required', 400);
    }

    const result = await orderEntryService.discontinueOrder(orderId, req.user.uid, reason);
    return success(res, result, 'Order discontinued');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/orders/patient/:uid — Patient orders
// ===================================================================

router.get('/orders/patient/:uid', async (req, res, next) => {
  try {
    const { uid } = req.params;
    const { order_type, status, date_from, date_to, page, limit } = req.query;

    const result = await orderEntryService.getPatientOrders(uid, {
      order_type,
      status,
      date_from,
      date_to,
      page,
      limit,
    });

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: uid,
      recordType: 'clinical_order',
      action: 'READ',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result.orders, 'Patient orders retrieved', 200, result.pagination);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/orders/encounter/:encounterId — Encounter orders
// ===================================================================

router.get('/orders/encounter/:encounterId', async (req, res, next) => {
  try {
    const { encounterId } = req.params;
    const result = await orderEntryService.getEncounterOrders(encounterId);
    return success(res, result, 'Encounter orders retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/order-sets — List order sets
// ===================================================================

router.get('/order-sets', async (req, res, next) => {
  try {
    const { category } = req.query;
    const result = await orderEntryService.getOrderSets(category || null);
    return success(res, result, 'Order sets retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/order-sets — Create order set
// ===================================================================

router.post('/order-sets', async (req, res, next) => {
  try {
    const { name, description, category, orders } = req.body;

    if (!name || !category || !orders) {
      return error(res, 'name, category, and orders are required', 400);
    }

    const result = await orderEntryService.createOrderSet({
      name,
      description,
      category,
      orders,
      created_by: req.user.uid,
    });

    return success(res, result, 'Order set created', 201);
  } catch (err) {
    next(err);
  }
});

export default router;
