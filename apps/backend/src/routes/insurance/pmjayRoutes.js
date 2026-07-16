// src/routes/insurance/pmjayRoutes.js
//
// Sprint 16 — PM-JAY workflow.

import { Router } from 'express';
import * as pmjay from '../../services/insurance/pmjayService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
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
      return relayAppError(res, err, 'PMJAY error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Packages
router.get('/packages', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.listPackages({
    scheme_code: req.query.scheme_code,
    specialty_group: req.query.specialty_group,
    q: req.query.q,
    limit: req.query.limit,
  }),
));

// Beneficiaries
router.post('/beneficiaries', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.upsertBeneficiary({ ...req.body, tenantId: tenantOf(req) }),
));

router.get('/beneficiaries/patient/:uid', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.listBeneficiariesForPatient({
    tenantId: tenantOf(req), patient_uid: req.params.uid,
  }),
));

router.post('/beneficiaries/:id/verify', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.verifyBeneficiary({
    tenantId: tenantOf(req),
    id: req.params.id,
    verified_by: req.user?.uid,
    verification_method: req.body.verification_method,
  }),
));

// Cases
router.post('/cases', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.createCase({
    ...req.body,
    tenantId: tenantOf(req), created_by: req.user?.uid,
  }),
));

router.get('/cases', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.listCases({
    tenantId: tenantOf(req),
    status: req.query.status,
    scheme_code: req.query.scheme_code,
    limit: req.query.limit,
  }),
));

router.get('/cases/:id', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.getCase({ tenantId: tenantOf(req), id: req.params.id }),
));

router.post('/cases/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  pmjay.transition({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
  }),
));

export default router;
