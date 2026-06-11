// src/routes/insurance/claimsRoutes.js
//
// Sprint 5 — TPA pre-auth + cashless claim + reimbursement workflow.
// Mounted at /api/v1/insurance/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as claims from '../../services/insurance/claimsService.js';
import * as capsService from '../../services/insurance/claimCapsService.js';
import * as packages from '../../services/insurance/packagesService.js';
import { ENHANCEMENT_JUSTIFICATION_TEMPLATE } from '../../services/insurance/clinicalJustificationTemplate.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function tenantOf(req) {
  return req?.tenantId || req?.user?.tenant_id || req?.user?.tenantId || req?.tenant?.id ||
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

// ── Package master + cost estimator ─────────────────────────────────
// Admission-counter surface: derive a package-based estimate instead of
// free-texting estimated_cost / expected_cost into the admission + the
// TPA pre-auth. Finding:
// 2026-05-09-tpa-insurance-claim-admission-no-estimated-cost-package-calculator
router.get('/packages', requireStaffOrAdmin, wrap(async (req) =>
  packages.listPackages({
    tenantId: tenantOf(req),
    specialty: req.query.specialty,
    status: req.query.status,
    q: req.query.q,
  }),
));

router.post('/packages/estimate', requireStaffOrAdmin, wrap(async (req) =>
  packages.estimatePackageCost({
    tenantId: tenantOf(req),
    package_id: req.body.package_id,
    package_code: req.body.package_code,
    room_category: req.body.room_category,
    los_days: req.body.los_days,
  }),
));

router.get('/packages/:id', requireStaffOrAdmin, wrap(async (req) =>
  packages.getPackage({ tenantId: tenantOf(req), id: req.params.id }),
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
    // Optional payer signal — when the TPA portal echoes the deciding
    // insurer, the payer-match guard treats it as authoritative (mirrors
    // the pre-auth response path). Free-text references are the fallback.
    insurer: req.body.insurer,
    raw_response: req.body.raw_response,
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

// ── A11 — per-category claim caps (migration 178) ───────────────────
// Replaces the unstructured documents.caps jsonb merged in batch 9.

router.get('/claims/:id/caps', requireStaffOrAdmin, wrap(async (req) =>
  capsService.getClaimCaps(req.params.id, { tenantId: tenantOf(req) }),
));

// Bulk upsert. Body: { caps: [{ category, max_amount, currency?, source?, notes? }, ...] }
router.post('/claims/:id/caps', requireStaffOrAdmin, wrap(async (req) =>
  capsService.setClaimCaps({
    tenantId: tenantOf(req),
    claimId: req.params.id,
    caps: req.body.caps,
    actorUid: req.user?.uid,
  }),
));

router.delete('/claims/:id/caps/:category', requireStaffOrAdmin, wrap(async (req) =>
  capsService.deleteCap({
    tenantId: tenantOf(req),
    claimId: req.params.id,
    category: req.params.category,
    actorUid: req.user?.uid,
  }),
));

// Cap-application preview. Body: { lines: [{ category, amount }, ...] }.
// Pure read-side — useful for the biller to dry-run an invoice against
// the live caps before posting.
router.post('/claims/:id/caps/apply', requireStaffOrAdmin, wrap(async (req) =>
  capsService.applyCapsToInvoiceLines(req.params.id, req.body.lines || [], { tenantId: tenantOf(req) }),
));

// ── Enhancement clinical-justification template ─────────────────────
// Structured template the chart + billing enhancement surfaces validate
// against. Finding:
// 2026-05-09-tpa-insurance-claim-doctor-no-clinical-justification-template
router.get('/enhancement-justification-template', requireStaffOrAdmin, wrap(async () =>
  ENHANCEMENT_JUSTIFICATION_TEMPLATE,
));

// ── Documents + correspondence ──────────────────────────────────────
router.post('/documents', requireStaffOrAdmin, wrap(async (req) =>
  claims.attachDocument({
    tenantId: tenantOf(req),
    uploaded_by: req.user?.uid,
    ...req.body,
  }),
));

router.post('/correspondence', requireStaffOrAdmin, wrap(async (req) =>
  claims.logCorrespondence({
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

export default router;
