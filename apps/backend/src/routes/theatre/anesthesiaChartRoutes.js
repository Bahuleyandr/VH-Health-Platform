// src/routes/theatre/anesthesiaChartRoutes.js — Sprint 17

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import * as svc from '../../services/theatre/anesthesiaChartService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import {
  positiveIntOrNull,
  routePatientGuard,
  selectorTenantOf,
} from '../../middleware/routePatientAccessGuards.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// Re-audit M: the /api/v1/anesthesia mount used to wrap this router in
// patientAccessGuard('ANESTHESIA_CHART'), which ran before route match and
// could never resolve a patient. All three routes here are about ONE theatre
// case — the chart entries of a single ot_schedules row — so each carries the
// guard with a selector that resolves that case row to its patient,
// tenant-scoped (the same lookup recordEntry/listForCase perform).
export async function selectAnesthesiaCasePatient(req, rawScheduleId) {
  const tenantId = selectorTenantOf(req);
  const scheduleId = positiveIntOrNull(rawScheduleId);
  if (tenantId == null || scheduleId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM ot_schedules
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    scheduleId,
  );
  return rows[0] ?? null;
}

const guardAnesthesiaEntryCreate = routePatientGuard('ANESTHESIA_CHART', {
  tag: 'anesthesia:body-ot-schedule-id',
  patientSelector: (req) => selectAnesthesiaCasePatient(req, req.body?.ot_schedule_id),
});
const guardAnesthesiaCaseRead = routePatientGuard('ANESTHESIA_CHART', {
  tag: 'anesthesia:ot-schedule-param',
  patientSelector: (req) => selectAnesthesiaCasePatient(req, req.params?.scheduleId),
});

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
      return relayAppError(res, err, 'Anesthesia error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

router.post('/entries', requireStaffOrAdmin, guardAnesthesiaEntryCreate, wrap(async (req) =>
  svc.recordEntry({
    ...req.body,
    tenantId: tenantOf(req), recorded_by: req.user?.uid,
  }),
));

router.get('/entries/case/:scheduleId', requireStaffOrAdmin, guardAnesthesiaCaseRead, wrap(async (req) =>
  svc.listForCase({
    tenantId: tenantOf(req), ot_schedule_id: req.params.scheduleId,
  }),
));

router.get('/totals/case/:scheduleId', requireStaffOrAdmin, guardAnesthesiaCaseRead, wrap(async (req) =>
  svc.totalsForCase({
    tenantId: tenantOf(req), ot_schedule_id: req.params.scheduleId,
  }),
));

export default router;
