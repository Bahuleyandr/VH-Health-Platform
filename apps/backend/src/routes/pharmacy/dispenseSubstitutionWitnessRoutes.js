// src/routes/pharmacy/dispenseSubstitutionWitnessRoutes.js
//
// Two-person witness approval flow for controlled (Schedule X / narcotic)
// dispense-substitutions. Mounted at
// /api/v1/pharmacy-orders/dispense-substitution/witness-approvals (and the
// /api/v1/pharmacy alias); the :id/approve router is mounted at app level
// (like the counter-sale and inventory witness approval routers) so eligible
// clinical witnesses who lack pharmacy-order roles can still approve.
//
// Contract mirrors counterSaleRoutes / inventoryV2Routes exactly:
//   * requesting requires a dispensing role; approving accepts any
//     CONTROLLED_DISPENSE_WITNESS_ROLES member;
//   * the witness may re-authenticate in-band with employeeId+password
//     (StaffAuthService lockout applies); the password is deleted from the
//     body and NEVER enters the persisted idempotency hash — the projection
//     hashes only { credentialMode, employeeId, substitution };
//   * Idempotency-Key is REQUIRED on both mutations so transport replays
//     return the durable original approval instead of minting duplicates.

import { Router } from 'express';
import {
  requestSubstitutionWitnessApproval,
  approveSubstitutionWitnessApproval,
} from '../../controllers/pharmacy/pharmacyOrderController.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  PHARMACY_INCHARGE,
  PHARMACY_STAFF,
  hasRole,
  normalizeRole,
} from '../../utils/roles.js';
import { CONTROLLED_DISPENSE_WITNESS_ROLES } from '../../services/pharmacy/controlledDispenseWitnessService.js';
import { StaffAuthService } from '../../services/auth/staffAuthService.js';
import { AppError } from '../../utils/AppError.js';
import {
  pharmacyOrderGuard,
  selectPatientFromBodyUid,
} from './pharmacyOrderPatientGuards.js';

const router = Router();
export const pharmacySubstitutionWitnessApprovalRoutes = Router({ mergeParams: true });

// Per-route patient access guard (see pharmacyOrderPatientGuards.js). A
// substitution witness request must name its patient (resolveSubstitutionPhase0
// rejects a missing body.patient_uid), so the guard forces patient context:
// the request is a controlled-dispense action about exactly one patient.
// The :id/approve router mounted at app level is deliberately untouched — the
// witness approves an unchanged, already-guarded payload and may hold a
// clinical role with no pharmacy-order route access.
const guardSubstitutionWitnessPatient = pharmacyOrderGuard(selectPatientFromBodyUid, {
  requirePatientContext: true,
});

export const SUBSTITUTION_DISPENSE_ROLES = [PHARMACY_STAFF, PHARMACY_INCHARGE];
export const SUBSTITUTION_WITNESS_APPROVAL_HOST_ROLES = [
  ...new Set([...SUBSTITUTION_DISPENSE_ROLES, ...CONTROLLED_DISPENSE_WITNESS_ROLES]),
];
const SUBSTITUTION_WITNESS_CANONICAL_PATH =
  '/api/v1/pharmacy-orders/dispense-substitution/witness-approvals';

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Substitution witness approval error');
    }
  };
}

function requireSubstitutionRole(allowedRoles, message) {
  return (req, res, next) => {
    if (!hasRole(req.user, allowedRoles) && !hasRole(req.user?.rawRole, allowedRoles)) {
      return error(res, message, 403);
    }
    return next();
  };
}

const requireDispense = requireSubstitutionRole(
  SUBSTITUTION_DISPENSE_ROLES, 'Pharmacy dispensing role required',
);
const requireApprovalHost = requireSubstitutionRole(
  SUBSTITUTION_WITNESS_APPROVAL_HOST_ROLES,
  'Pharmacy dispenser or clinical witness role required',
);

// Witness passwords must never enter the persisted idempotency hash: project
// the body down to the credential MODE + employee id + the substitution intent.
function witnessApprovalIdempotencyBody(req) {
  const body = req.body || {};
  const usesStaffPassword = Object.hasOwn(body, 'employeeId') || Object.hasOwn(body, 'password');
  return {
    credentialMode: usesStaffPassword ? 'staff_password' : 'bearer',
    employeeId: usesStaffPassword
      ? String(body.employeeId || '').trim().toUpperCase() || null
      : null,
    substitution: body.substitution || {},
  };
}

async function resolveWitnessActor(req, tenantId) {
  const employeeId = req.body?.employeeId;
  const password = req.body?.password;
  if (employeeId == null && password == null) {
    return { actorUid: req.user?.uid, requesterUid: null };
  }
  try {
    if (!employeeId || !password) {
      throw AppError.badRequest(
        'Witness employee ID and password are required together',
        'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_REQUIRED',
      );
    }
    const witness = await StaffAuthService.authenticateControlledDispenseWitness({
      employeeId,
      password,
      req,
      tenantId,
    });
    if (String(witness.tenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
      throw AppError.forbidden(
        'Witness authentication tenant mismatch',
        'CONTROLLED_DISPENSE_WITNESS_TENANT_MISMATCH',
      );
    }
    return { actorUid: witness.uid, requesterUid: req.user?.uid };
  } finally {
    if (req.body && Object.hasOwn(req.body, 'password')) delete req.body.password;
  }
}

router.post('/', requireDispense, guardSubstitutionWitnessPatient, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_substitution_witness_request',
  retainOnServerError: true,
  requestPathForIdempotency: SUBSTITUTION_WITNESS_CANONICAL_PATH,
}), wrap(async (req) => requestSubstitutionWitnessApproval({
  ...req.body,
  tenantId: req.tenantId,
  requested_by: req.user?.uid,
  requested_role: normalizeRole(req.user?.role),
})));

pharmacySubstitutionWitnessApprovalRoutes.post('/', requireApprovalHost, requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_substitution_witness_approval',
  retainOnServerError: true,
  requestBodyForIdempotency: witnessApprovalIdempotencyBody,
  requestPathForIdempotency: (req) =>
    `${SUBSTITUTION_WITNESS_CANONICAL_PATH}/${req.params.id}/approve`,
}), wrap(async (req) => {
  const tenantId = req.tenantId;
  const actor = await resolveWitnessActor(req, tenantId);
  return approveSubstitutionWitnessApproval({
    approvalId: req.params.id,
    ...actor,
    substitution: {
      ...(req.body.substitution || {}),
      tenantId,
    },
  });
}));

export default router;
