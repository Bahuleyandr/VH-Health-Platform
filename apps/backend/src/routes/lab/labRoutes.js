// src/routes/lab/labRoutes.js
//
// Sprint 3 — Lab results / critical alerts / pathologist worklist.
// Mounted at /api/v1/lab/*. Complementary to /api/v1/hl7/receive
// which is the inbound transport for analyzer ORU messages.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as lab from '../../services/lab/labResultsService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

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

router.get('/results/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  lab.getResultsForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
    limit: req.query.limit,
  }),
));

// ── Pathologist worklist + sign-off ──────────────────────────────────
router.get('/pathologist/pending', requireStaffOrAdmin, wrap(async (req) =>
  lab.listPendingSignOff({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.post('/pathologist/signoff', requireStaffOrAdmin, wrap(async (req) =>
  lab.signOffResults({
    tenantId: tenantOf(req),
    signed_off_by: req.user?.uid,
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
