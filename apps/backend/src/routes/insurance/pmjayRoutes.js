// src/routes/insurance/pmjayRoutes.js
//
// Sprint 16 — PM-JAY workflow.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as pmjay from '../../services/insurance/pmjayService.js';
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
      logger.error('pmjay route error:', err);
      return error(res, err.message || 'PMJAY error', 500);
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
  pmjay.upsertBeneficiary({ tenantId: tenantOf(req), ...req.body }),
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
    tenantId: tenantOf(req), created_by: req.user?.uid, ...req.body,
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
    tenantId: tenantOf(req), id: req.params.id, ...req.body,
  }),
));

export default router;
