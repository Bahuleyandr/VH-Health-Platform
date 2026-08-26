// src/routes/theatre/orBoardRoutes.js
//
// Sprint 6 — operational OR board, room master, procedure catalog, and
// conflict-aware booking. Mounted at /api/v1/theatre/*. The clinical
// documentation routes (under /api/v1/surgical/*) cover the per-case
// docs and are unchanged.

import { Router } from 'express';
import * as orBoard from '../../services/theatre/orBoardService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitOrBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = Router();

// Re-audit M: the /api/v1/theatre mount used to wrap this router in
// patientAccessGuard('OPERATING_THEATRE'), which ran before route match and
// could never resolve a patient. The only route here that serves a single
// patient subject is POST /bookings (it creates an ot_schedules case for
// body.patient_uid); it now carries the guard itself. Everything else on this
// router — room master, procedure catalog, the conflict pre-check (room/time
// overlap facts, no patient identifiers in its response), the OR board and the
// throughput/safety aggregates — has no single patient subject and keeps the
// mount's role gate only.
const guardOrBookingCreate = routePatientGuard('OPERATING_THEATRE', {
  tag: 'or-board:body-patient-uid',
  patientSelector: (req) => ({ uid: req.body?.patient_uid }),
});

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
      return relayAppError(res, err, 'OR board error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// ── Room master ──────────────────────────────────────────────────────
router.get('/rooms', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.listOrRooms({ status: req.query.status }),
));

router.post('/rooms', requireAdmin, wrap(async (req) =>
  orBoard.upsertOrRoom(req.body),
));

// ── Procedure catalog ────────────────────────────────────────────────
router.get('/procedures', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.listProcedures({
    specialty: req.query.specialty,
    q: req.query.q,
  }),
));

// ── Booking ──────────────────────────────────────────────────────────
router.post('/bookings/conflict-check', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.findConflicts({ ...req.body, tenantId: tenantOf(req) }),
));

router.post('/bookings', requireStaffOrAdmin, guardOrBookingCreate, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const result = await orBoard.scheduleWithConflictCheck({ ...req.body, tenantId });
  // Real-time OR board: a case created via the conflict-aware booking path also
  // surfaces live (mirrors the emit on POST /theatre/schedule in theatreRoutes.js).
  emitOrBoardEvent('scheduled', { scheduleId: result?.schedule?.id, status: result?.schedule?.status, tenantId });
  return result;
}));

// ── OR board (today's view) ─────────────────────────────────────────
router.get('/board', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getOrBoard({
    tenantId: tenantOf(req),
    date: req.query.date,
    ot_room: req.query.ot_room,
  }),
));

router.get('/throughput/daily', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getDailyThroughput({
    tenantId: tenantOf(req),
    date: req.query.date,
    ot_room: req.query.ot_room,
  }),
));

router.get('/safety/weekly', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getWeeklySafetyCompliance({
    tenantId: tenantOf(req),
    from: req.query.from,
    to: req.query.to,
  }),
));

export default router;
