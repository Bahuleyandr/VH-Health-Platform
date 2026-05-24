// src/routes/lab/labRoutes.js
//
// Sprint 3 — Lab results / critical alerts / pathologist worklist.
// Mounted at /api/v1/lab/*. Complementary to /api/v1/hl7/receive
// which is the inbound transport for analyzer ORU messages.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as lab from '../../services/lab/labResultsService.js';
import * as investigationService from '../../services/investigation/investigationService.js';
import * as investigationOrderService from '../../services/investigation/orderService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isClinical, isStaff } from '../../utils/roleHelpers.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('lab route error:', err);
      return error(res, err.message || 'Lab error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requirePatientUidParam(req, res, next) {
  if (!UUID_RE.test(String(req.params.patientUid || ''))) {
    return error(res, 'patientUid must be a valid UUID', 400);
  }
  next();
}

// ── Inbound HL7 ORU (HTTP transport) ─────────────────────────────────
// Bypasses standard JSON middleware — clients post the raw HL7 string
// in a `message` field. Auth is the standard JWT layer (analyzers
// typically use an API-key + service account; this endpoint inherits
// the existing api-key + jwt middleware chain from app.js).
router.post('/oru/ingest', requireStaffOrAdmin, wrap(async (req) => {
  const { message, source } = req.body || {};
  return lab.ingestOruMessage(message, {
    tenantId: tenantOf(req),
    source: source || req.user?.role || 'manual',
  });
}));

// ── Doctor-facing lab order shortcut ──────────────────────────────────
// `/api/v1/lab/orders` is the documented endpoint the staff app expects;
// it didn't exist before, so doctors trying to place a CBC/electrolytes
// order from the IPD chart hit a 404 and had to discover the actual
// `/api/v1/investigations/order` path by trial-and-error (plus the
// payload shape mismatch). Delegate to the investigation order service
// so both endpoints behave identically — same notes persistence, same
// patient_uid resolution, same priority + type coercion. Findings:
//   2026-05-10-dynamic-acute-abdomen-doctor-lab-order-endpoint-missing-notes-dropped
//   2026-05-10-inpatient-admission-doctor-lab-orders-notes-dropped-no-batch
function requireOrderingStaff(req, res, next) {
  const role = req.user?.role;
  if (!isClinical(role) && !isAdmin(role)) {
    return error(res, 'Lab ordering requires clinical staff or admin role', 403);
  }
  next();
}

router.post('/orders', requireOrderingStaff, wrap(async (req) => {
  const body = req.body || {};
  // Resolve patient_id from patient_uid if the caller used the UUID
  // form (the documented lab-order shape per the swarm finding) — the
  // investigations service expects patient_id (int). Pass through
  // notes / priority / clinical context unchanged.
  let patientId = body.patient_id;
  if (!patientId && body.patient_uid) {
    const { default: prisma } = await import('../../lib/prisma.js');
    const row = await prisma.users.findUnique({
      where: { uid: String(body.patient_uid) },
      select: { id: true },
    });
    patientId = row?.id;
    if (!patientId) {
      throw Object.assign(new Error('patient_uid does not match any user'), { statusCode: 404 });
    }
  }
  const result = await investigationOrderService.createInvestigationOrder({
    patient_id: patientId,
    doctor_uid: req.user?.uid,
    orderedBy: req.user?.uid,
    test_name: body.test_name,
    test_code: body.test_code,
    // /lab/orders is lab-only by definition; default the type so callers
    // don't have to pass `type: "LAB"` again.
    type: body.type || 'LAB',
    priority: body.priority,
    notes: body.notes ?? body.clinical_note ?? body.clinical_notes,
    collection_location: body.collection_location,
    collection_deadline_at: body.collection_deadline_at,
    fasting_required: body.fasting_required,
    fasting_instructions: body.fasting_instructions,
  });
  return result;
}));

// ── Sample collection / barcode / rejection workflow ────────────────
// D43 — expose the lab-facing sample lifecycle under /api/v1/lab so a
// lab tech can collect a sample, print/scan the barcode, and reject a
// bad specimen without discovering the older /investigations routes.
router.post('/samples/:investigationId/collect', requireStaffOrAdmin, wrap(async (req) =>
  investigationService.markSampleCollected({
    id: req.params.investigationId,
    collected_by: req.user?.uid,
    collected_notes: req.body?.collected_notes ?? req.body?.notes,
    sample_barcode: req.body?.sample_barcode,
    tenantId: tenantOf(req),
  }),
));

router.get('/samples/barcode/:barcode', requireStaffOrAdmin, wrap(async (req) =>
  investigationService.getSampleByBarcode({
    barcode: req.params.barcode,
    tenantId: tenantOf(req),
  }),
));

router.get('/samples/:investigationId/barcode', requireStaffOrAdmin, wrap(async (req) =>
  investigationService.getSampleByInvestigationId({
    id: req.params.investigationId,
    tenantId: tenantOf(req),
  }),
));

router.post('/samples/:investigationId/reject', requireStaffOrAdmin, wrap(async (req) =>
  investigationService.rejectSample({
    id: req.params.investigationId,
    rejected_by: req.user?.uid,
    rejection_reason: req.body?.rejection_reason ?? req.body?.reason,
    tenantId: tenantOf(req),
  }),
));

// ── Manual result entry (when no analyzer integration) ───────────────
router.post('/results', requireStaffOrAdmin, wrap(async (req) =>
  lab.recordResultManual({
    tenantId: tenantOf(req),
    performed_by: req.user?.uid,
    result: req.body,
  }),
));

router.get('/results/booking/:bookingId', requireStaffOrAdmin, wrap(async (req) =>
  lab.getResultsForBooking({
    tenantId: tenantOf(req),
    booking_id: req.params.bookingId,
  }),
));

router.get('/results/patient/:patientUid', requireStaffOrAdmin, requirePatientUidParam, wrap(async (req) =>
  lab.getResultsForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
    limit: req.query.limit,
    include_preliminary: req.query.include_preliminary,
  }),
));

// ── IPD lab worklist (E-5) ──────────────────────────────────────────
router.get('/worklist/ipd', requireStaffOrAdmin, wrap(async (req) =>
  lab.listIpdLabWorklist({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

// ── General lab worklist ────────────────────────────────────────────
// All open investigations across OPD walk-ins, ER, and IPD — without
// the admission inner join the /worklist/ipd endpoint applies. STAT/
// URGENT orders sort to the top regardless of source. Findings:
//   2026-05-10-emergency-walk-in-lab-tech-stat-er-order-not-on-worklist
//   2026-05-08-obstetric-anc-lab-tech-no-worklist-endpoint
router.get('/worklist', requireStaffOrAdmin, wrap(async (req) =>
  lab.listLabWorklist({
    tenantId: tenantOf(req),
    limit: req.query.limit,
    priority: req.query.priority,
    source: req.query.source,
  }),
));

// ── Pathologist worklist + sign-off ──────────────────────────────────
router.get('/pathologist/pending', requireStaffOrAdmin, wrap(async (req) =>
  lab.listPendingSignOff({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

// B-3 — pathologist tier gate. Route-layer requireRole + the
// service-level canSignOffLabResults() form a defence-in-depth pair so
// neither can be bypassed alone (route forgets, service stays safe;
// internal call bypasses route, role is still required).
function requirePathologistTier(req, res, next) {
  const role = req.user?.role;
  if (!['PATHOLOGIST', 'LAB_INCHARGE', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
    return error(res, 'Lab signoff requires pathologist tier', 403);
  }
  next();
}

router.post('/pathologist/signoff', requirePathologistTier, wrap(async (req) =>
  lab.signOffResults({
    tenantId: tenantOf(req),
    signed_off_by: req.user?.uid,
    signed_off_by_role: req.user?.role,
    signed_off_by_name: req.body.signed_off_by_name || req.user?.name,
    signed_off_by_reg: req.body.signed_off_by_reg,
    result_ids: req.body.result_ids,
    decision: req.body.decision,
    comments: req.body.comments,
    booking_id: req.body.booking_id,
    patient_uid: req.body.patient_uid,
  }),
));

// ── Critical alerts ──────────────────────────────────────────────────
router.get('/alerts/critical', requireStaffOrAdmin, wrap(async (req) =>
  lab.listOpenCriticalAlerts({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.post('/alerts/critical/:id/ack', requireStaffOrAdmin, wrap(async (req) =>
  lab.acknowledgeAlert(req.params.id, {
    acknowledged_by: req.user?.uid,
    acknowledged_by_name: req.body.acknowledged_by_name || req.user?.name,
    read_back_method: req.body.read_back_method,
    notes: req.body.notes,
  }),
));

export default router;
