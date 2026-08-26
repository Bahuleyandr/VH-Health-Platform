// src/routes/clinical/nursingAssessmentRoutes.js
//
// Sprint 15 — NEWS2 + Braden + Morse + sepsis screen.

import { Router } from 'express';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import * as svc from '../../services/clinical/nursingAssessmentService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

// ── Per-route patient-access guards ─────────────────────────────────────────
// The NURSING_ASSESSMENT guard used to sit on the /api/v1/nursing-assessments
// mount in app.js. A mount-level middleware runs before Express matches the
// route, so req.params was always empty there and GET /patient/:uid resolved
// no patient — the guard passed as no_patient_context without a policy
// decision, in shadow AND in enforce. The guard now runs per route:
//   * POST /            — subject is body.patient_uid, the exact (snake-case
//                         only) field recordAssessment destructures and
//                         requires.
//   * GET /patient/:uid — subject is the :uid path param the handler passes
//                         to listForPatient.
// resolvePatientForAccess verifies the selected uid against users within the
// request tenant; a malformed uid resolves to null with no query, and
// requirePatientContext then refuses in enforce mode (unresolved-deny audit
// row in shadow) instead of passing silently.
//
// POST /score (pure computation over submitted vitals — it reads and writes
// no patient row) and GET /dashboard/overdue-or-high-risk (tenant-wide queue,
// no single subject) are deliberately NOT patient-context-forced: they keep
// the mount RBAC + requireStaffOrAdmin gates only.
const assessmentPatientGuard = (patientSelector) => patientAccessGuard('NURSING_ASSESSMENT', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector,
});

function assessmentBodyPatientOf(req) {
  const uid = req.body?.patient_uid;
  return uid ? { uid } : null;
}

function assessmentParamPatientOf(req) {
  return { uid: req.params?.uid };
}

const guardAssessmentWrite = assessmentPatientGuard(assessmentBodyPatientOf);
const guardPatientAssessments = assessmentPatientGuard(assessmentParamPatientOf);

// Test surface (labPathologyNursingRouteGuards.test.js) — not a public API.
export const __patientAccessSelectors = {
  assessmentBodyPatientOf,
  assessmentParamPatientOf,
};

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
      return relayAppError(res, err, 'Assessment error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Pure-compute scoring without persisting (for previews / "what would this score").
router.post('/score', requireStaffOrAdmin, wrap(async (req) => {
  const { kind, inputs } = req.body ?? {};
  return svc.score(kind, inputs ?? {});
}));

router.post('/', requireStaffOrAdmin, guardAssessmentWrite, wrap(async (req) =>
  svc.recordAssessment({
    ...req.body,
    tenantId: tenantOf(req),
    assessed_by: req.user?.uid,
  }),
));

router.get('/patient/:uid', requireStaffOrAdmin, guardPatientAssessments, wrap(async (req) =>
  svc.listForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.uid,
    kind: req.query.kind,
    limit: req.query.limit,
  }),
));

router.get('/dashboard/overdue-or-high-risk', requireStaffOrAdmin, wrap(async (req) =>
  svc.listOverdueOrHighRisk({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

export default router;
