// src/routes/emr/orderRoutes.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  enforceStaffClinicalWriteDevicePosture,
  rejectMobileClinicalWrite,
} from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import * as orderEntryService from '../../services/emr/orderEntryService.js';
import * as orderSetGovernanceService from '../../services/emr/orderSetGovernanceService.js';
import {
  isContentStudioEnabled,
  setContentStudioEnabled,
} from '../../services/emr/orderSetContentStudioSettingsService.js';
import {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
  patientAccessErrorPayload,
} from '../../services/security/accessDecisionService.js';
import prisma from '../../lib/prisma.js';
import { hashRequestBody } from '../../services/idempotency/idempotencyService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

const guardClinicalOrderView = patientAccessGuard('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardClinicalOrderWrite = patientAccessGuard('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});
const guardClinicalOrderResourceWrite = patientAccessGuardForResource('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'clinical_order',
});
const guardClinicalOrderVerification = patientAccessGuardForResource('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY,
  resourceType: 'clinical_order',
});
const guardClinicalOrderMarRecovery = patientAccessGuardForResource('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_MAR_RECOVERY,
  resourceType: 'clinical_order',
});
const guardClinicalOrderEncounterView = patientAccessGuardForResource('CLINICAL_ORDER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'encounter',
  idParam: 'encounterId',
});

const MEDICATION_ORDER_WRITE_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'MEDICAL_SUPERINTENDENT',
]);

function roleCanWriteMedicationOrder(req) {
  return MEDICATION_ORDER_WRITE_ROLES.has(String(req.user?.role || '').trim().toUpperCase());
}

function isMedicationOrderType(orderType) {
  const raw = String(orderType || '').toLowerCase().trim();
  return raw === 'medication' || raw === 'med' || raw === 'medication_order';
}

function rejectMedicationWrite(res) {
  return error(res, 'Only doctors can prescribe or edit inpatient medication orders', 403);
}

function requireMedicationOrderWriteRole(req, res, next) {
  if (roleCanWriteMedicationOrder(req)) return next();
  return rejectMedicationWrite(res);
}

function requireMedicationOrderWriteRoleForBody(req, res, next) {
  if (!isMedicationOrderType(req.body?.order_type)) return next();
  return requireMedicationOrderWriteRole(req, res, next);
}

function requireMedicationOrderWriteRoleForBulk(req, res, next) {
  const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!orders.some((order) => isMedicationOrderType(order?.order_type))) return next();
  return requireMedicationOrderWriteRole(req, res, next);
}

function requireMedicationOrderVerificationRole(req, res, next) {
  if (orderEntryService.canVerifyMedicationOrderRole(req.user?.role)) return next();
  return error(res, 'Only inpatient nursing and pharmacy staff can verify clinical orders', 403);
}

async function requireClinicalOrderVerificationAuthority(req, res, next) {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order ID', 400);
    }
    if (!req.tenantId) {
      return error(res, 'Tenant context required', 403);
    }
    const order = await prisma.clinical_orders.findFirst({
      where: { id: orderId, tenant_id: req.tenantId },
      select: { order_type: true },
    });
    if (!order) return error(res, 'Order not found', 404);
    if (!orderEntryService.canVerifyClinicalOrderType(req.user?.role, order.order_type)) {
      return error(
        res,
        'Pharmacy staff can verify medication orders only; other clinical orders require inpatient nursing verification',
        403,
      );
    }
    req.clinicalOrderVerification = { orderId, orderType: order.order_type };
    return next();
  } catch (err) {
    return next(err);
  }
}

async function requireMedicationOrderMarRecoveryAuthority(req, res, next) {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order ID', 400);
    }
    if (!req.tenantId) {
      return error(res, 'Tenant context required', 403);
    }
    const order = await prisma.clinical_orders.findFirst({
      where: { id: orderId, tenant_id: req.tenantId },
      select: { order_type: true },
    });
    if (!order) return error(res, 'Order not found', 404);
    if (!isMedicationOrderType(order.order_type)) {
      return error(res, 'Only medication orders own a MAR schedule', 409);
    }
    req.medicationOrderMarRecovery = { orderId, orderType: order.order_type };
    return next();
  } catch (err) {
    return next(err);
  }
}

async function guardBulkOrderPatients(req, res, next) {
  try {
    const patientUids = [...new Set(
      (Array.isArray(req.body?.orders) ? req.body.orders : [])
        .map((order) => order?.patient_uid)
        .filter(Boolean),
    )];
    for (const patientUid of patientUids) {
      const decision = await authorizePatientAccessRequest(req, {
        policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
        recordType: 'CLINICAL_ORDER',
        patient: { uid: patientUid },
        requireResolvedPatient: true,
      });
      if (!decision.allowed) {
        return res.status(403).json(patientAccessErrorPayload(decision));
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

async function ensureExistingMedicationWriteAllowed(req, res, orderId) {
  const order = await prisma.clinical_orders.findUnique({
    where: { id: Number(orderId) },
    select: { order_type: true },
  });
  if (!order || order.order_type !== 'medication') return true;
  if (roleCanWriteMedicationOrder(req)) return true;
  rejectMedicationWrite(res);
  return false;
}

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

router.post('/orders', enforceStaffClinicalWriteDevicePosture, requireMedicationOrderWriteRoleForBody, guardClinicalOrderWrite, requireIdempotencyKey({ required: true, scope: 'clinical_order' }), async (req, res, next) => {
  try {
    const {
      encounter_id, er_visit_id, patient_uid, order_type, priority,
      start_date, end_date, notes,
    } = req.body;
    // resolveOrderDetails (chip stage-5-6) folds body.stat + the
    // structured route into the details payload, so `stat` no longer
    // needs its own destructure. er_visit_id stays — the createOrder
    // call below passes it through (chip stage-5-1, ER-encounter linkage).
    const details = resolveOrderDetails(req.body);

    if (!patient_uid || !order_type || isEmptyDetails(details)) {
      return error(res, 'patient_uid, order_type, and details are required', 400);
    }
    const result = await orderEntryService.createOrder({
      encounter_id: encounter_id || null,
      er_visit_id: er_visit_id || null,
      patient_uid,
      order_type,
      priority,
      details,
      ordered_by: req.user.uid,
      start_date,
      end_date,
      notes,
      tenantId: req.tenantId,
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

router.post('/orders/apply-set', requireMedicationOrderWriteRole, enforceStaffClinicalWriteDevicePosture, guardClinicalOrderWrite, requireIdempotencyKey({ required: false, scope: 'clinical_order_apply_set' }), async (req, res, next) => {
  try {
    const { patient_uid, encounter_id, order_set_id } = req.body;

    if (!patient_uid || !order_set_id) {
      return error(res, 'patient_uid and order_set_id are required', 400);
    }
    const result = await orderEntryService.applyOrderSet(
      patient_uid,
      encounter_id || null,
      order_set_id,
      req.user.uid,
      req.tenantId
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

router.post('/orders/bulk', enforceStaffClinicalWriteDevicePosture, requireMedicationOrderWriteRoleForBulk, guardBulkOrderPatients, requireIdempotencyKey({ required: false, scope: 'clinical_order_bulk' }), async (req, res, next) => {
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
      tenantId: req.tenantId,
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
// POST /emr/orders/:id/retry-mar-scheduling — Repair MAR integration
// ===================================================================
//
// This does not prescribe, edit, or reinterpret a medication order. It
// replays the exact active CPOE schedule through the same order-owned MAR
// materializer used on initial create and records canonical recovery evidence.
// Doctor authority and a replay-safe HTTP command key are both mandatory.
router.post(
  '/orders/:id/retry-mar-scheduling',
  requireMedicationOrderWriteRole,
  enforceStaffClinicalWriteDevicePosture,
  guardClinicalOrderMarRecovery,
  requireMedicationOrderMarRecoveryAuthority,
  requireIdempotencyKey({ required: true, scope: 'clinical_order_mar_retry' }),
  async (req, res, next) => {
    try {
      const { orderId } = req.medicationOrderMarRecovery;

      const result = await orderEntryService.retryMedicationOrderMarScheduling({
        tenantId: req.tenantId,
        orderId,
        actorUid: req.user.uid,
        actorRole: req.user.role,
      });
      logPhiAccess({
        userId: req.user.uid,
        userRole: req.user.role,
        patientId: result.patient_uid,
        recordType: 'clinical_order:mar_recovery',
        action: 'UPDATE',
        ip: req.ip,
        requestId: req.id,
      });
      return success(res, result, 'MAR scheduling recovered');
    } catch (err) {
      return next(err);
    }
  },
);

// ===================================================================
// PUT /emr/orders/:id/verify — Verify an order
// ===================================================================

router.put(
  '/orders/:id/verify',
  requireMedicationOrderVerificationRole,
  enforceStaffClinicalWriteDevicePosture,
  guardClinicalOrderVerification,
  requireClinicalOrderVerificationAuthority,
  requireIdempotencyKey({
    required: true,
    scope: 'clinical_order_verify',
    requestBodyForIdempotency: (req) => ({
      actor_role: String(req.user?.role || '').trim().toUpperCase(),
      body: req.body || {},
    }),
  }),
  async (req, res, next) => {
    try {
      const { orderId } = req.clinicalOrderVerification;

      const result = await orderEntryService.verifyOrder(orderId, req.user.uid, {
        tenantId: req.tenantId,
        actorRole: req.user.role,
        idempotencyKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestBodySha256: hashRequestBody(req.body || {}),
      });
      return success(res, result, 'Order verified');
    } catch (err) {
      return next(err);
    }
  },
);

// ===================================================================
// PUT /emr/orders/:id/complete — Complete an order
// ===================================================================

router.put('/orders/:id/complete', rejectMobileClinicalWrite, guardClinicalOrderResourceWrite, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }
    if (!(await ensureExistingMedicationWriteAllowed(req, res, orderId))) return null;

    const result = await orderEntryService.completeOrder(orderId, req.user.uid);
    return success(res, result, 'Order completed');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/cancel — Cancel an order
// ===================================================================

router.put('/orders/:id/cancel', rejectMobileClinicalWrite, guardClinicalOrderResourceWrite, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    if (!reason) {
      return error(res, 'Cancellation reason is required', 400);
    }
    if (!(await ensureExistingMedicationWriteAllowed(req, res, orderId))) return null;

    const result = await orderEntryService.cancelOrder(orderId, req.user.uid, reason);
    return success(res, result, 'Order cancelled');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// PUT /emr/orders/:id/discontinue — Discontinue an order
// ===================================================================

router.put('/orders/:id/discontinue', rejectMobileClinicalWrite, guardClinicalOrderResourceWrite, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (isNaN(orderId)) {
      return error(res, 'Invalid order ID', 400);
    }

    if (!reason) {
      return error(res, 'Discontinuation reason is required', 400);
    }
    if (!(await ensureExistingMedicationWriteAllowed(req, res, orderId))) return null;

    const result = await orderEntryService.discontinueOrder(orderId, req.user.uid, reason);
    return success(res, result, 'Order discontinued');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/orders/patient/:uid — Patient orders
// ===================================================================

router.get('/orders/patient/:uid', guardClinicalOrderView, async (req, res, next) => {
  try {
    const { uid } = req.params;
    const { order_type, status, date_from, date_to, page, limit } = req.query;

    const result = await orderEntryService.getPatientOrders(uid, {
      tenantId: req.tenantId,
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

router.get('/orders/encounter/:encounterId', guardClinicalOrderEncounterView, async (req, res, next) => {
  try {
    const { encounterId } = req.params;
    const { page, limit } = req.query;
    const result = await orderEntryService.getEncounterOrders(encounterId, {
      tenantId: req.tenantId,
      page,
      limit,
    });
    return success(res, result.orders, 'Encounter orders retrieved', 200, result.pagination);
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
      tenantId: req.tenantId,
    });

    return success(res, result, 'Order set created', 201);
  } catch (err) {
    next(err);
  }
});

wrapAutoRBAC(router, 'orderSetStudioRoutes', {
  get: [
    ['/order-sets/studio', async (req, res) => {
      const result = await orderSetGovernanceService.listOrderSetsForStudio({
        tenantId: req.tenantId,
        status: req.query.status || null,
      });
      return success(res, result, 'Order-set studio queue retrieved');
    }],
    ['/order-sets/studio/settings', async (req, res) => {
      const enabled = await isContentStudioEnabled(req.tenantId);
      return success(res, { tenant_id: req.tenantId, enabled }, 'Content studio settings retrieved');
    }],
  ],
  post: [
    ['/order-sets/studio/settings', async (req, res) => {
      const result = await setContentStudioEnabled(req.tenantId, req.body?.enabled === true, {
        actorUid: req.user.uid,
        snapshot: req.body?.acceptance_snapshot || null,
      });
      return success(res, result, 'Content studio settings updated');
    }],
    ['/order-sets/import', async (req, res) => {
      const result = await orderSetGovernanceService.importOrderSetDocument({
        tenantId: req.tenantId,
        document: req.body?.document || req.body,
        actor: req.user,
        dryRun: req.body?.dry_run === true,
        sourceFile: req.body?.source_file || null,
      });
      return success(res, result, req.body?.dry_run === true ? 'Order-set import dry run completed' : 'Order-set import landed as draft', 201);
    }],
    ['/order-sets/:id/new-version', async (req, res) => {
      const result = await orderSetGovernanceService.cloneOrderSetVersion({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order-set draft version created', 201);
    }],
    ['/order-sets/:id/submit', async (req, res) => {
      const result = await orderSetGovernanceService.submitOrderSetForReview({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order set submitted for review');
    }],
    ['/order-sets/:id/pharmacy-review', async (req, res) => {
      const result = await orderSetGovernanceService.recordPharmacyReview({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Pharmacy review recorded');
    }],
    ['/order-sets/:id/approve', async (req, res) => {
      const result = await orderSetGovernanceService.approveOrderSet({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order set approved and deployed');
    }],
    ['/order-sets/:id/reject', async (req, res) => {
      const result = await orderSetGovernanceService.rejectOrderSet({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order set returned to draft');
    }],
    ['/order-sets/:id/retire', async (req, res) => {
      const result = await orderSetGovernanceService.retireOrderSet({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order set retired');
    }],
    ['/order-sets/:id/rollback', async (req, res) => {
      const result = await orderSetGovernanceService.rollbackOrderSet({
        tenantId: req.tenantId,
        orderSetId: req.params.id,
        actor: req.user,
        note: req.body?.note || null,
      });
      return success(res, result, 'Order set rolled back');
    }],
  ],
}, { requirePhone: false });

export default router;
