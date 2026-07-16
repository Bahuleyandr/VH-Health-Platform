// src/routes/bed/bedInspectionRoutes.js
//
// D1 — bed inspection / consumer-choice flow routes.
// Mounted at /api/v1/bed-inspections/*.

import { Router } from 'express';
import * as svc from '../../services/bed/bedInspectionService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      // Shared relay (responseHelper.relayAppError): surfaces AppError
      // code+details per the documented envelope; non-AppErrors get a logged
      // generic 500 that never relays raw err.message.
      return relayAppError(res, err, 'Bed inspection error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Start an inspection. Body: { appointment_id?, patient_uid,
//   shown_bed_ids: int[], inspected_by_attender?, attender_phone?,
//   notes?, expires_in_hours? }
router.post('/', requireStaffOrAdmin, wrap(async (req) =>
  svc.startInspection({
    appointmentId: req.body.appointment_id ?? null,
    patientUid: req.body.patient_uid,
    shownBedIds: req.body.shown_bed_ids,
    inspectedByAttender: req.body.inspected_by_attender,
    attenderPhone: req.body.attender_phone,
    notes: req.body.notes,
    initiatedBy: req.user?.uid,
    expiresInHours: req.body.expires_in_hours,
    tenantId: tenantOf(req),
  }),
));

// Record decision. Body: { decision, chosen_bed_id?, notes? }
router.post('/:id/decide', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordDecision({
    inspectionId: req.params.id,
    decision: req.body.decision,
    chosenBedId: req.body.chosen_bed_id,
    notes: req.body.notes,
    actorUid: req.user?.uid,
    tenantId: req.tenantId,
  }),
));

// Active inspection for a patient (if any).
router.get('/patient/:patientUid/active', requireStaffOrAdmin, wrap(async (req) =>
  svc.getActiveForPatient(req.params.patientUid),
));

// Full history per appointment.
router.get('/appointment/:appointmentId', requireStaffOrAdmin, wrap(async (req) =>
  svc.listForAppointment(req.params.appointmentId),
));

// Manual sweep entry-point (cron also calls this from scheduler.js).
router.post('/expire-stale', requireStaffOrAdmin, wrap(async () =>
  svc.expireStaleInspections(),
));

export default router;
