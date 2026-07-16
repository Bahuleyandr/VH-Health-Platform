// src/routes/paediatric/paediatricImmunisationRoutes.js
//
// A10 — paediatric immunisation routes. Mounted at /api/v1/paediatric/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/paediatric/paediatricImmunisationService.js';
import { success, error } from '../../utils/responseHelper.js';
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
      // AppError (statusCode set): surface the machine-readable `code` and
      // structured `details` so clients receive the documented
      // { success, message, code, details } envelope (apps/backend/CLAUDE.md).
      // Same fix as maternityRoutes' wrap (#598) — this file's copy of the
      // pasted pattern kept dropping both, which left the D6-R2 422 anonymous
      // and the #589 retry-triple 409s (HISTORY_FINAL / LINK_CHANGED /
      // LINK_NOT_EXACT) indistinguishable on the wire. The helper lifts
      // topLevel.* to the response root and nests the rest under `details`.
      if (err.statusCode) {
        return error(res, err.message, err.statusCode, {
          ...(err.code ? { topLevel: { code: err.code } } : {}),
          ...(err.details || {}),
        });
      }
      // Unexpected (non-AppError): log the full error server-side and return a
      // generic message. Never pass raw err.message to the client — sanitize
      // only genericises 5xx in production, so relaying err.message here would
      // leak internals on non-prod (test/staging) deployments.
      logger.error('paediatric immunisation route error:', err);
      return error(res, 'Paediatric immunisation error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role) && req.user?.role !== 'SUPER_ADMIN') {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Catalogue (read-only browser).
router.get('/immunisations/catalogue', requireStaffOrAdmin, wrap(async (req) =>
  svc.listCatalogue({ tenantId: tenantOf(req) }),
));

// Seed a paediatric patient's schedule from DOB. Idempotent.
// Body: { patient_uid, dob: YYYY-MM-DD }
router.post('/immunisations/seed', requireStaffOrAdmin, wrap(async (req) =>
  svc.seedScheduleForPatient({
    patientUid: req.body.patient_uid,
    dob: req.body.dob,
    tenantId: tenantOf(req),
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
  }),
));

// All immunisation rows for a patient (chronological).
router.get('/immunisations/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  svc.listForPatient(req.params.patientUid, { tenantId: tenantOf(req) }),
));

// Due-or-overdue scheduled rows only. Powers the paeds-OPD "due now" panel.
router.get('/immunisations/patient/:patientUid/due', requireStaffOrAdmin, wrap(async (req) =>
  svc.listDueForPatient(req.params.patientUid, { asOf: req.query.asOf || null, tenantId: tenantOf(req) }),
));

// Record a dose given (or mark missed / refused / contraindicated).
// Body: { status, given_at?, given_by_name?, batch_number?,
//         manufacturer?, site_of_injection?, adverse_event?, notes? }
router.post('/immunisations/:id/given', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordDose({
    tenantId: tenantOf(req),
    immunisationId: req.params.id,
    status: req.body.status || 'given',
    givenAt: req.body.given_at,
    givenBy: req.user?.uid,
    givenByName: req.body.given_by_name,
    batchNumber: req.body.batch_number,
    manufacturer: req.body.manufacturer,
    siteOfInjection: req.body.site_of_injection,
    adverseEvent: req.body.adverse_event,
    notes: req.body.notes,
    actorRole: req.user?.role,
  }),
));

export default router;
