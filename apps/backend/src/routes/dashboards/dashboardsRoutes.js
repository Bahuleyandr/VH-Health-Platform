// src/routes/dashboards/dashboardsRoutes.js
//
// Sprint 9 — admin / clinical-management dashboards. Two surfaces:
//   - /api/v1/dashboards/snapshot/* — direct SQL into bi_* views,
//     useful for the admin portal's "today" widgets without an
//     iframe round-trip.
//   - /api/v1/dashboards/embed/* — Metabase signed-URL helper for
//     iframe-embedded dashboards.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { resolveDoctorFilterId } from '../../services/doctor/doctorRefService.js';
import * as snapshot from '../../services/dashboards/snapshotService.js';
import * as metabase from '../../services/dashboards/metabaseService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin } from '../../utils/roleHelpers.js';

const router = Router();

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('dashboards route error:', err);
      return error(res, err.message || 'Dashboard error', 500);
    }
  };
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// ── Direct snapshot queries ─────────────────────────────────────────
router.get('/snapshot/daily-ops', requireAdmin, wrap(async () =>
  snapshot.getDailyOpsSnapshot(),
));

router.get('/snapshot/opd-daily', requireAdmin, wrap(async (req) =>
  snapshot.getOpdDaily({
    from: req.query.from,
    to: req.query.to,
    // Roadmap A9: canonicalize to users.id whichever id space the caller used.
    doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
      tenantId: req.tenantId || null,
    }),
  }),
));

router.get('/snapshot/ip-occupancy', requireAdmin, wrap(async (req) =>
  snapshot.getIpOccupancy({
    from: req.query.from,
    to: req.query.to,
    ward: req.query.ward,
  }),
));

router.get('/snapshot/doctor-productivity', requireAdmin, wrap(async () =>
  snapshot.getDoctorProductivity30d(),
));

router.get('/snapshot/payer-mix', requireAdmin, wrap(async (req) =>
  snapshot.getPayerMixMonthly({
    months: req.query.months || 6,
  }),
));

router.get('/snapshot/lab-tat', requireAdmin, wrap(async (req) =>
  snapshot.getLabTatSummary({
    from: req.query.from,
    to: req.query.to,
  }),
));

// ── Metabase embedding ──────────────────────────────────────────────
router.get('/embed/list', requireAdmin, wrap(async () =>
  metabase.listDashboards(),
));

router.post('/embed/url', requireAdmin, wrap(async (req) =>
  metabase.buildEmbedUrl({
    key: req.body.key,
    params: req.body.params || {},
    ttlSeconds: req.body.ttlSeconds,
  }),
));

export default router;
