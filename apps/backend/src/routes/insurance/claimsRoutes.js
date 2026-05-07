// src/routes/insurance/claimsRoutes.js
//
// Sprint 5 — TPA pre-auth + cashless claim + reimbursement workflow.
// Mounted at /api/v1/insurance/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as claims from '../../services/insurance/claimsService.js';
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
      logger.error('insurance route error:', err);
      return error(res, err.message || 'Insurance error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── Policies ─────────────────────────────────────────────────────────
router.post('/policies', requireStaffOrAdmin, wrap(async (req) =>
  claims.upsertPolicy({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/policies/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  claims.listPoliciesForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

// ── Pre-authorization ────────────────────────────────────────────────
router.post('/preauth', requireStaffOrAdmin, wrap(async (req) =>
  claims.createPreauth({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/preauth/pending', requireStaffOrAdmin, wrap(async (req) =>
  claims.listPendingPreauths({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.get('/preauth/:id', requireStaffOrAdmin, wrap(async (req) =>
  claims.getPreauth({
    tenantId: tenantOf(req),
    id: req.params.id,
  }),
));

router.post('/preauth/:id/submit', requireStaffOrAdmin, wrap(async (req) =>
  claims.submitPreauth({
    tenantId: tenantOf(req),
    id: req.params.id,
    submitted_by: req.user?.uid,
    submission_channel: req.body.submission_channel,
    tpa_reference_id: req.body.tpa_reference_id,
  }),
));

router.post('/preauth/:id/response', requireStaffOrAdmin, wrap(async (req) =>
  claims.recordPreauthResponse({
    tenantId: tenantOf(req),
    preauth_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

// ── Claims ───────────────────────────────────────────────────────────
router.post('/claims', requireStaffOrAdmin, wrap(async (req) =>
  claims.createClaim({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/claims', requireStaffOrAdmin, wrap(async (req) =>
  claims.listClaims({
    tenantId: tenantOf(req),
    status: req.query.status,
    patient_uid: req.query.patient_uid,
    claim_type: req.query.claim_type,
    aging_bucket: req.query.aging_bucket,
    limit: req.query.limit,
  }),
));

router.get('/claims/:id', requireStaffOrAdmin, wrap(async (req) =>
  claims.getClaimBundle({
    tenantId: tenantOf(req),
    id: req.params.id,
  }),
));

router.post('/claims/:id/submit', requireStaffOrAdmin, wrap(async (req) =>
  claims.submitClaim({
    tenantId: tenantOf(req),
    id: req.params.id,
    submitted_by: req.user?.uid,
    submission_channel: req.body.submission_channel,
    tpa_reference_id: req.body.tpa_reference_id,
  }),
));

router.post('/claims/:id/decision', requireStaffOrAdmin, wrap(async (req) =>
  claims.recordClaimDecision({
    tenantId: tenantOf(req),
    id: req.params.id,
    decision: req.body.decision,
    approved_amount: req.body.approved_amount,
    denial_reason: req.body.denial_reason,
    recorded_by: req.user?.uid,
  }),
));

router.post('/claims/:id/payment', requireStaffOrAdmin, wrap(async (req) =>
  claims.recordClaimPayment({
    tenantId: tenantOf(req),
    id: req.params.id,
    paid_amount: req.body.paid_amount,
    payment_reference: req.body.payment_reference,
    paid_at: req.body.paid_at,
    recorded_by: req.user?.uid,
  }),
));

// ── Documents + correspondence ──────────────────────────────────────
router.post('/documents', requireStaffOrAdmin, wrap(async (req) =>
  claims.attachDocument({
    uploaded_by: req.user?.uid,
    ...req.body,
  }),
));

router.post('/correspondence', requireStaffOrAdmin, wrap(async (req) =>
  claims.logCorrespondence({
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

export default router;
