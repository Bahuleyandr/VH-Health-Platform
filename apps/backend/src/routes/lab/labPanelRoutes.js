// src/routes/lab/labPanelRoutes.js
//
// Architectural item A5 — structured manual lab-result entry endpoints.
//
// Sibling to:
//   - labRoutes.js          : HL7 ORU ingestion + per-result manual entry
//   - microbiologyRoutes.js : culture/sensitivity workflow
//
// Mounted at /api/v1/lab/panels and /api/v1/lab/reference-ranges by app.js.
// Mount-level RBAC is set there; this file adds path-level gates only
// where admin-only writes need an extra check (reference-range upserts).
//
// See finding 2026-05-08-lab-walk-in-lab-tech-no-structured-results.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as panelSvc from '../../services/lab/labPanelService.js';
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
      logger.error('lab panel route error:', err);
      return error(res, err.message || 'Lab panel error', 500);
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
  if (!isAdmin(req.user?.role)) {
    return error(res, 'Admin role required', 403);
  }
  next();
}

// ── Panel recording / fetch ─────────────────────────────────────────
// POST /api/v1/lab/panels
// Body: { panelCode, patientUid, bookingId?, performedAt?, performedByLab?,
//         analytes: [{ test_code, test_name, loinc_code?, value_numeric?,
//                      value_text?, unit?, comments?, status? }] }
router.post('/panels', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.recordLabPanel({
    tenantId: tenantOf(req),
    performedByUid: req.user?.uid,
    panelCode: req.body.panelCode,
    patientUid: req.body.patientUid,
    bookingId: req.body.bookingId ?? null,
    performedAt: req.body.performedAt ?? null,
    performedByLab: req.body.performedByLab ?? null,
    analytes: req.body.analytes,
  }),
));

// GET /api/v1/lab/panels/:panelId
router.get('/panels/:panelId', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.getLabPanel(req.params.panelId),
));

// GET /api/v1/lab/panels/patient/:patientUid?panelCode=&limit=
router.get('/panels/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.listPatientPanels(req.params.patientUid, {
    panelCode: req.query.panelCode || null,
    limit: req.query.limit,
  }),
));

// ── Trends ──────────────────────────────────────────────────────────
// GET /api/v1/lab/trends/:patientUid/:testCode?fromDate=&toDate=&limit=
router.get('/trends/:patientUid/:testCode', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.getAnalyteTrend(req.params.patientUid, req.params.testCode, {
    fromDate: req.query.fromDate || null,
    toDate: req.query.toDate || null,
    limit: req.query.limit,
  }),
));

// ── Reference range admin ───────────────────────────────────────────
// GET /api/v1/lab/reference-ranges?testCode=&includeInactive=
router.get('/reference-ranges', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.listReferenceRanges({
    tenantId: tenantOf(req),
    testCode: req.query.testCode || null,
    includeInactive: req.query.includeInactive === 'true',
  }),
));

// POST /api/v1/lab/reference-ranges
// Admin-only — covers both create + update (id presence drives upsert).
router.post('/reference-ranges', requireAdmin, wrap(async (req) =>
  panelSvc.upsertReferenceRange(req.body, { tenantId: tenantOf(req) }),
));

export default router;
