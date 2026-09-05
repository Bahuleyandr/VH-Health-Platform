// src/routes/paediatric/paediatricImmunisationRoutes.js
//
// A10 — paediatric immunisation routes. Mounted at /api/v1/paediatric/*.

import { Router } from 'express';
import * as svc from '../../services/paediatric/paediatricImmunisationService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

import { patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessPolicyRegistry.js';

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
//
// Serves both the list and the due-list read; same :patientUid, same child.
const guardPaediatricImmunisationPatient = routePatientGuard('PAEDIATRIC_IMMUNISATION', {
  tag: 'paediatric:patient-uid-param',
  patientSelector: (req) => ({ uid: req.params?.patientUid }),
});


// Recording a dose mutates a named child's immunisation record under a
// DOSE id, which the mount guard cannot see. requireStaffOrAdmin is a role
// check, not a patient-scoped one.
//
// The VIEW policy is used because it is the ONLY policy this record type
// has: policyCodeForRecordType maps PAEDIATRIC_IMMUNISATION to
// PATIENT_MATERNITY_PAEDIATRIC_VIEW, and the mount's own guard already
// resolves to it. Introducing a write policy is a wider design decision
// than closing this gap, so this matches the mount rather than inventing
// a second answer.
const guardImmunisationDose = patientAccessGuardForResource('PAEDIATRIC_IMMUNISATION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW,
  resourceType: 'immunisation',
  idParam: 'id',
  careTeamModeGoverned: true,
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
      // generic 500 that never relays raw err.message. Extracted from this
      // file's #602 fix so exactly one implementation of the pattern exists.
      return relayAppError(res, err, 'Paediatric immunisation error');
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
router.get('/immunisations/patient/:patientUid', requireStaffOrAdmin, guardPaediatricImmunisationPatient, wrap(async (req) =>
  svc.listForPatient(req.params.patientUid, { tenantId: tenantOf(req) }),
));

// Due-or-overdue scheduled rows only. Powers the paeds-OPD "due now" panel.
router.get('/immunisations/patient/:patientUid/due', requireStaffOrAdmin, guardPaediatricImmunisationPatient, wrap(async (req) =>
  svc.listDueForPatient(req.params.patientUid, { asOf: req.query.asOf || null, tenantId: tenantOf(req) }),
));

// Record a dose given (or mark missed / refused / contraindicated).
// Body: { status, given_at?, given_by_name?, batch_number?,
//         manufacturer?, site_of_injection?, adverse_event?, notes? }
router.post('/immunisations/:id/given', requireStaffOrAdmin, guardImmunisationDose, wrap(async (req) =>
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
