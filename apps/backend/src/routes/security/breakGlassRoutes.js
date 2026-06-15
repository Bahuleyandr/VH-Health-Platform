// src/routes/security/breakGlassRoutes.js
//
// CareTeam ABAC — PHI-access break-glass activation lifecycle endpoints
// (design §5). These make `enforce` mode usable: a break-glass-eligible
// clinician who is genuinely locked out of a patient's chart can audibly
// override.
//
//   POST   /api/v1/patient-access/break-glass        activate an override
//   DELETE /api/v1/patient-access/break-glass/:id     revoke an active override
//   GET    /api/v1/patient-access/break-glass         list active overrides
//
// RBAC is applied via wrapAutoRBAC against the `patientAccessBreakGlassRoutes`
// key, which is the CURRENT break-glass-eligible set ONLY (SUPER_ADMIN / ADMIN /
// CMO / MEDICAL_SUPERINTENDENT — rolePolicyGraph.js:1389 phi.can_break_glass).
// Widening eligibility to front-line clinicians is a clinical-governance
// decision and is intentionally NOT made here (design §8 Q1).
//
// The service (breakGlassService.js) owns the transactional writes (row +
// status history in one setTenantTx), the loud security alert, and the
// server-side reason/eligibility validation. These handlers stay thin: validate
// input shape, derive tenant/actor from the request (never req.user.tenant_id —
// use req.tenantId), call the service, respond via success()/error().

import { Router } from 'express';
import { validationResult } from 'express-validator';

import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';
import logger from '../../logging/logger.js';
import {
  activateBreakGlass,
  revokeBreakGlass,
  listActiveBreakGlass,
} from '../../services/security/breakGlassService.js';
import { success, error } from '../../utils/responseHelper.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import {
  requiredUUID,
  requiredString,
  optionalString,
  paramId,
  queryInt,
} from '../../validators/sharedValidators.js';

const router = Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 'Validation failed', 400, { errors: errors.array() });
  }
  next();
};

function tenantOf(req) {
  return req.tenantId
    || req.tenant?.id
    || DEFAULT_TENANT_ID;
}

function actorOf(req) {
  return req.acting?.actorUid || req.user?.uid || null;
}

function roleOf(req) {
  return req.acting?.actorRole || req.user?.role || null;
}

/**
 * POST /api/v1/patient-access/break-glass
 * Body: { patient_uid, reason (≥8 chars), expires_in_hours? (1–24, default 2) }
 * Activate a PHI-access break-glass override for one patient.
 */
async function activateHandler(req, res) {
  try {
    const row = await activateBreakGlass({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      actorUid: actorOf(req),
      actorRole: roleOf(req),
      reason: req.body.reason,
      expiresInHours: req.body.expires_in_hours,
    });

    // HIPAA trail: a break-glass activation IS a privileged PHI-access event.
    logPhiAccess({
      userId: actorOf(req),
      userRole: roleOf(req),
      patientId: row.patient_uid,
      recordType: 'PHI_BREAK_GLASS',
      action: 'BREAK_GLASS_ACTIVATE',
      ip: req.ip,
      requestId: req.id,
      tenantId: tenantOf(req),
    });

    return success(res, row, 'Break-glass access activated', 201);
  } catch (err) {
    if (err?.statusCode) {
      return error(res, err.message, err.statusCode, err.details || null);
    }
    logger.error('Break-glass activation failed:', { error: err?.message });
    return error(res, 'Failed to activate break-glass access', 500);
  }
}

/**
 * DELETE /api/v1/patient-access/break-glass/:id
 * Revoke an active break-glass override before it expires.
 */
async function revokeHandler(req, res) {
  try {
    const row = await revokeBreakGlass({
      id: req.params.id,
      tenantId: tenantOf(req),
      actorUid: actorOf(req),
    });

    logPhiAccess({
      userId: actorOf(req),
      userRole: roleOf(req),
      patientId: row.patient_uid,
      recordType: 'PHI_BREAK_GLASS',
      action: 'BREAK_GLASS_REVOKE',
      ip: req.ip,
      requestId: req.id,
      tenantId: tenantOf(req),
    });

    return success(res, row, 'Break-glass access revoked');
  } catch (err) {
    if (err?.statusCode) {
      return error(res, err.message, err.statusCode, err.details || null);
    }
    logger.error('Break-glass revoke failed:', { error: err?.message });
    return error(res, 'Failed to revoke break-glass access', 500);
  }
}

/**
 * GET /api/v1/patient-access/break-glass?patientUid=&limit=
 * List ACTIVE (non-expired) overrides for the tenant, optionally per patient.
 */
async function listHandler(req, res) {
  try {
    const rows = await listActiveBreakGlass({
      tenantId: tenantOf(req),
      patientUid: req.query.patientUid || req.query.patient_uid || null,
      limit: req.query.limit,
    });
    return success(res, rows, 'Active break-glass sessions retrieved');
  } catch (err) {
    logger.error('Break-glass list failed:', { error: err?.message });
    return error(res, 'Failed to list break-glass sessions', 500);
  }
}

wrapAutoRBAC(
  router,
  'patientAccessBreakGlassRoutes',
  {
    post: [
      ['/', [requiredUUID('patient_uid'), requiredString('reason', 1000), optionalString('expires_in_hours', 8)], validate, activateHandler],
    ],
    delete: [
      ['/:id', [paramId('id')], validate, revokeHandler],
    ],
    get: [
      ['/', [queryInt('limit', { min: 1, max: 200 })], validate, listHandler],
    ],
  },
  // Break-glass-eligible roles are all non-PATIENT, so the wrapAutoRBAC
  // identity validators (requireUID/requirePhone) would no-op anyway; disable
  // them explicitly since this surface keys off patient_uid + reason, not the
  // caller's own uid/phone.
  { requireUID: false, requirePhone: false },
);

export default router;
