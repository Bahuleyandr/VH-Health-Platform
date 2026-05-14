// src/routes/emr/orderRoutes.js
import express from 'express';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import * as orderEntryService from '../../services/emr/orderEntryService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// The staff Orders sheet posts the medication / lab / radiology fields
// flat on the body (medication, dosage, route, frequency, duration,
// instructions, investigation, reason, …). The canonical contract is a
// nested `details` object. Accept both shapes — when `details` is
// missing or empty, derive it from the well-known type-specific flat
// fields so a doctor on an older staff build doesn't lose the order to
// a 400. Finding 2026-05-12-inpatient-admission-doctor-dee11e39.
// Shared by POST /orders and POST /orders/bulk.
const isEmptyDetails = (v) =>
  v === undefined || v === null ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function resolveOrderDetails(body) {
  let { details } = body;
  if (!isEmptyDetails(details)) return details;

  const t = String(body.order_type || '').toLowerCase();
  if (t === 'medication') {
    details = {
      medication_name: body.medication ?? body.medication_name ?? null,
      dose: body.dosage ?? body.dose ?? null,
      route: body.route ?? null,
      frequency: body.frequency ?? null,
      duration: body.duration ?? null,
      instructions: body.instructions ?? null,
      stat: body.stat === true || body.stat === 'true',
    };
  } else if (t === 'investigation' || t === 'lab' || t === 'radiology') {
    details = {
      test_name: body.investigation ?? body.test_name ?? null,
      test_code: body.test_code ?? null,
      reason: body.reason ?? body.clinical_indication ?? null,
      fasting_required: body.fasting_required ?? null,
    };
  } else if (t === 'consult' || t === 'consultation' || t === 'referral') {
    details = {
      specialty: body.specialty ?? null,
      reason: body.reason ?? null,
    };
  } else if (t === 'nursing') {
    details = {
      description: body.description ?? null,
      frequency: body.frequency ?? null,
      instructions: body.instructions ?? null,
    };
  }
  // Drop nulls so the service doesn't persist empty fields.
  if (details && typeof details === 'object') {
    details = Object.fromEntries(
      Object.entries(details).filter(([, v]) => v !== null && v !== ''),
    );
  }
  return details;
}

// ===================================================================
// POST /emr/orders — Create a clinical order
// ===================================================================

router.post('/orders', requireIdempotencyKey({ required: false, scope: 'clinical_order' }), async (req, res, next) => {
  try {
    const { encounter_id, patient_uid, order_type, priority, start_date, end_date, notes } = req.body;
    const details = resolveOrderDetails(req.body);

    if (!patient_uid || !order_type || isEmptyDetails(details)) {
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
// POST /emr/orders/bulk — Create multiple clinical orders atomically
// ===================================================================
//
// An admission round enters a routine bundle (IV fluids + a few meds +
// labs + imaging) as one clinical action. Without this, that was N
// single-order POSTs — N round-trips, N CDS runs, and no rollback if
// the Nth failed. The service validates + runs CDS for every item up
// front, then inserts all rows in one transaction.
// Finding 2026-05-08-inpatient-admission-doctor-no-batch-ordering.

router.post('/orders/bulk', requireIdempotencyKey({ required: false, scope: 'clinical_order_bulk' }), async (req, res, next) => {
  try {
    const { encounter_id, orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return error(res, 'orders must be a non-empty array', 400);
    }
    if (orders.length > 50) {
      return error(res, 'orders array too large — max 50 per batch', 400);
    }

    // Each item accepts the same flat-or-nested shape as POST /orders. A
    // batch-level encounter_id is the default; an item may still carry
    // its own. The service runs full per-item validation + CDS up front.
    const items = orders.map((o) => {
      const body = { ...o };
      if (body.encounter_id === undefined && encounter_id !== undefined) {
        body.encounter_id = encounter_id;
      }
      return {
        encounter_id: body.encounter_id || null,
        patient_uid: body.patient_uid,
        order_type: body.order_type,
        priority: body.priority,
        details: resolveOrderDetails(body),
        start_date: body.start_date,
        end_date: body.end_date,
        notes: body.notes,
      };
    });

    const result = await orderEntryService.createOrdersBulk(items, {
      ordered_by: req.user.uid,
    });

    // PHI log per distinct patient — a batch is normally one admission,
    // but log each patient touched so the audit trail is complete.
    const distinctPatients = [...new Set(items.map((it) => it.patient_uid).filter(Boolean))];
    for (const patientUid of distinctPatients) {
      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: patientUid,
        recordType: 'clinical_order:bulk',
        action: 'CREATE',
        ip: req.ip,
        requestId: req.id,
      });
    }

    return success(res, result, `${result.length} orders created`, 201);
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
