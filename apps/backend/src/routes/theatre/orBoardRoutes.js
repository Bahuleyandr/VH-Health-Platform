// src/routes/theatre/orBoardRoutes.js
//
// Sprint 6 — operational OR board, room master, procedure catalog, and
// conflict-aware booking. Mounted at /api/v1/theatre/*. The clinical
// documentation routes (under /api/v1/admin/surgical/*) cover the
// per-case docs and are unchanged.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as orBoard from '../../services/theatre/orBoardService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('orBoard route error:', err);
      return error(res, err.message || 'OR board error', 500);
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
  orBoard.findConflicts(req.body),
));

router.post('/bookings', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.scheduleWithConflictCheck(req.body),
));

// ── OR board (today's view) ─────────────────────────────────────────
router.get('/board', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getOrBoard({
    date: req.query.date,
    ot_room: req.query.ot_room,
  }),
));

router.get('/throughput/daily', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getDailyThroughput({
    date: req.query.date,
    ot_room: req.query.ot_room,
  }),
));

router.get('/safety/weekly', requireStaffOrAdmin, wrap(async (req) =>
  orBoard.getWeeklySafetyCompliance({
    from: req.query.from,
    to: req.query.to,
  }),
));

export default router;
