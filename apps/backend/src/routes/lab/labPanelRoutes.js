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
import * as panelSvc from '../../services/lab/labPanelService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  getAuthenticatedActorRoles,
  isAdmin,
  isStaff,
} from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
//
// Serves both patient-scoped reads: /panels/patient/:patientUid and
// /trends/:patientUid/:testCode carry the subject in the same param.
const guardLabPanelPatient = routePatientGuard('LAB_RESULT', {
  tag: 'lab:patient-uid-param',
  patientSelector: (req) => ({ uid: req.params?.patientUid }),
});

const LAB_PANEL_RECORD_ROLES = new Set([
  'LAB_STAFF',
  'LAB_INCHARGE',
  'PATHOLOGIST',
  'ADMIN',
  'SUPER_ADMIN',
]);

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
      // generic 500 that never relays raw err.message (finding
      // 2026-05-10-lab-walk-in-lab-tech-result-submit-500). error() still
      // stamps requestId on the envelope root.
      return relayAppError(res, err, 'Lab panel error');
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

function requireLabPanelRecorder(req, res, next) {
  const roles = getAuthenticatedActorRoles(req.user);
  if (!roles.some((role) => LAB_PANEL_RECORD_ROLES.has(role))) {
    return error(res, 'Lab result entry role required', 403);
  }
  next();
}

// ── Panel recording / fetch ─────────────────────────────────────────
// POST /api/v1/lab/panels
// Idempotency-Key is required. Body must carry investigationId and/or bookingId.
// Body: { panelCode, patientUid, investigationId?, bookingId?, performedAt?,
//         analytes: [{ test_code, test_name, loinc_code?, value_numeric?,
//                      value_text?, unit?, comments?, status? }] }
router.post(
  '/panels',
  requireLabPanelRecorder,
  requireIdempotencyKey({ required: true, scope: 'lab-panel-record' }),
  wrap(async (req) =>
  panelSvc.recordLabPanel({
    tenantId: tenantOf(req),
    performedByUid: req.user?.uid,
    performedByRole: req.user?.role,
    panelCode: req.body.panelCode,
    patientUid: req.body.patientUid,
    bookingId: req.body.bookingId ?? null,
    investigationId: req.body.investigationId ?? req.body.investigation_id ?? null,
    performedAt: req.body.performedAt ?? null,
    analytes: req.body.analytes,
    idempotencyKey: req.idempotencyClaim?.requestKey,
    requestBodySha256: req.idempotencyClaim?.requestBodyHash,
    httpIdempotencyClaimId: req.idempotencyClaim?.id,
    requestId: req.id || null,
  })),
);

// GET /api/v1/lab/panels/:panelId
router.get('/panels/:panelId', requireStaffOrAdmin, wrap(async (req) =>
  panelSvc.getLabPanel(req.params.panelId, { tenantId: tenantOf(req) }),
));

// GET /api/v1/lab/panels/patient/:patientUid?panelCode=&limit=
router.get('/panels/patient/:patientUid', requireStaffOrAdmin, guardLabPanelPatient, wrap(async (req) =>
  panelSvc.listPatientPanels(req.params.patientUid, {
    tenantId: tenantOf(req),
    panelCode: req.query.panelCode || null,
    limit: req.query.limit,
  }),
));

// ── Trends ──────────────────────────────────────────────────────────
// GET /api/v1/lab/trends/:patientUid/:testCode?fromDate=&toDate=&limit=
router.get('/trends/:patientUid/:testCode', requireStaffOrAdmin, guardLabPanelPatient, wrap(async (req) =>
  panelSvc.getAnalyteTrend(req.params.patientUid, req.params.testCode, {
    tenantId: tenantOf(req),
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
