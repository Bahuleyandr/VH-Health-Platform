// src/routes/dashboards/dashboardsRoutes.js
//
// Sprint 9 — admin / clinical-management dashboards. Two surfaces:
//   - /api/v1/dashboards/snapshot/* — direct SQL into bi_* views,
//     useful for the admin portal's "today" widgets without an
//     iframe round-trip.
//   - /api/v1/dashboards/embed/* — Metabase signed-URL helper for
//     iframe-embedded dashboards.

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import { resolveDoctorFilterId } from '../../services/doctor/doctorRefService.js';
import * as snapshot from '../../services/dashboards/snapshotService.js';
import { getTeleconsultOpsSnapshot } from '../../services/dashboards/teleconsultOpsService.js';
import * as metabase from '../../services/dashboards/metabaseService.js';
import {
  listDashboardCatalog,
  listDatasetCatalog,
} from '../../services/dashboards/analyticsCatalogService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function roleOf(req) {
  return req.user?.rawRole || req.user?.role;
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Dashboard error');
    }
  };
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// ── Direct snapshot queries ─────────────────────────────────────────
router.get('/snapshot/daily-ops', requireAdmin, wrap(async (req) =>
  snapshot.getDailyOpsSnapshot({ tenantId: tenantOf(req) }),
));

router.get('/snapshot/teleconsult-ops', requireAdmin, wrap(async (req) =>
  getTeleconsultOpsSnapshot({
    tenantId: tenantOf(req),
    windowHours: req.query.window_hours || req.query.windowHours || 24,
  }),
));

router.get('/snapshot/opd-daily', requireAdmin, wrap(async (req) =>
  snapshot.getOpdDaily({
    tenantId: tenantOf(req),
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
    tenantId: tenantOf(req),
    from: req.query.from,
    to: req.query.to,
    ward: req.query.ward,
  }),
));

router.get('/snapshot/doctor-productivity', requireAdmin, wrap(async (req) =>
  snapshot.getDoctorProductivity30d({ tenantId: tenantOf(req) }),
));

router.get('/snapshot/payer-mix', requireAdmin, wrap(async (req) =>
  snapshot.getPayerMixMonthly({
    tenantId: tenantOf(req),
    months: req.query.months || 6,
  }),
));

router.get('/snapshot/lab-tat', requireAdmin, wrap(async (req) =>
  snapshot.getLabTatSummary({
    tenantId: tenantOf(req),
    from: req.query.from,
    to: req.query.to,
  }),
));

// ── Metabase embedding ──────────────────────────────────────────────
router.get('/catalog', requireAdmin, wrap(async (req) => {
  const [datasets, dashboards] = await Promise.all([
    listDatasetCatalog(),
    listDashboardCatalog({ role: roleOf(req), includeHeld: true }),
  ]);
  return { datasets, dashboards };
}));

router.get('/embed/list', requireAdmin, wrap(async (req) =>
  metabase.listDashboards({ role: roleOf(req) }),
));

router.post('/embed/url', requireAdmin, wrap(async (req) =>
  metabase.buildEmbedUrl({
    key: req.body.key,
    params: req.body.params || {},
    ttlSeconds: req.body.ttlSeconds,
    tenantId: tenantOf(req),
    role: roleOf(req),
  }),
));

// `src/routes/dashboard/` and `src/routes/dashboards/` are sibling directories
// differing only by a plural, so the directory bootstrap published `dashboard`
// and `dashboards` as two tags for one subject. `dashboard` is canonical (the
// registry's house style for domain nouns is singular).
markRouterDomain(router, 'dashboard');

export default router;
