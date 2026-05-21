// src/routes/insurance/admissionEnhancementRoutes.js
//
// Chart-context surface for mid-stay TPA enhancements. Mounted at
// /api/v1/admissions/:admissionId/tpa-enhancement.
//
// Background — what this route exists to solve:
//   1. The Sprint 5 TPA workflow (claimsService + /api/v1/insurance/*)
//      gates everything behind ADMIN / SUPER_ADMIN / BILLING_STAFF /
//      INSURANCE_COORDINATOR. A consultant looking at a patient chart
//      can't read the parent preauth or submit an enhancement — they'd
//      have to hand the work to billing. See finding
//      2026-05-10-tpa-insurance-claim-doctor-enhancement-rbac.
//   2. The legacy billing-side enhancement endpoint
//      (POST /api/v1/billing/insurance/claim/:id/enhancement) sits under
//      the /billing namespace, expects an `insurance_claims.id`, and is
//      invisible from the chart UI. See finding
//      2026-05-09-tpa-insurance-claim-doctor-enhancement-in-billing-not-chart.
//
// This file gives clinicians a single chart-shaped endpoint pair keyed
// off `admission_id` — the only id they have at hand. The handler
// resolves the parent preauth from the admission, then delegates to
// `claimsService.createPreauth` (request_type='enhancement',
// parent_preauth_id=parent.id) so the actual TPA workflow stays in
// one place.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import * as claims from '../../services/insurance/claimsService.js';
import { normalizeClinicalJustification, ENHANCEMENT_JUSTIFICATION_TEMPLATE } from '../../services/insurance/clinicalJustificationTemplate.js';
import { success, error } from '../../utils/responseHelper.js';

// mergeParams: true — `:admissionId` is declared on the parent mount in
// app.js (`/api/v1/admissions/:admissionId/tpa-enhancement`); without
// this flag the sub-router's `req.params.admissionId` is undefined.
const router = Router({ mergeParams: true });

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Find the parent preauth for an admission — the row with
 * parent_preauth_id IS NULL whose status is not cancelled/lapsed.
 * Multiple original preauths against one admission shouldn't happen
 * in practice, but order by `created_at DESC` so the most recent one
 * wins if it does.
 */
async function resolveParentPreauth(tenantId, admissionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, preauth_number, policy_id, patient_uid, admission_id,
            primary_diagnosis, sanctioned_amount, expected_cost, status,
            request_type, parent_preauth_id
       FROM insurance_preauth
      WHERE tenant_id = $1::uuid
        AND admission_id = $2::int
        AND parent_preauth_id IS NULL
        AND status NOT IN ('cancelled','lapsed')
      ORDER BY created_at DESC
      LIMIT 1`,
    tenantId, Number(admissionId),
  );
  return rows[0] || null;
}

/**
 * For a given parent preauth, fetch the enhancement children + summary
 * totals. cumulative_approved = sum(sanctioned_amount) across parent
 * + enhancements that the insurer signed off on. The cashier reads
 * this to know the real live cap on the admission, not the original
 * sanctioned amount.
 */
async function buildEnhancementChain(parent) {
  if (!parent) return null;
  const children = await prisma.$queryRawUnsafe(
    `SELECT id, preauth_number, request_type, parent_preauth_id,
            expected_cost, sanctioned_amount, status, submitted_at,
            sanctioned_at, validity_until, created_at
       FROM insurance_preauth
      WHERE parent_preauth_id = $1::int
        AND request_type = 'enhancement'
      ORDER BY created_at ASC`,
    parent.id,
  );

  const approvedStates = new Set(['approved', 'partially_approved']);
  const chain = [parent, ...children];

  let cumulativeApproved = 0;
  let cumulativeRequested = 0;
  for (const row of chain) {
    if (approvedStates.has(row.status)) {
      cumulativeApproved += Number(row.sanctioned_amount ?? 0);
    }
    if (!['cancelled', 'lapsed', 'denied'].includes(row.status)) {
      cumulativeRequested += Number(row.expected_cost ?? 0);
    }
  }

  return {
    parent,
    enhancements: children,
    cumulative_approved: cumulativeApproved,
    cumulative_requested: cumulativeRequested,
  };
}

// ── routes ──────────────────────────────────────────────────────────

// GET /api/v1/admissions/:admissionId/tpa-enhancement/template
//
// The clinical-justification template a consultant fills in before
// opening/submitting an enhancement. Mirrors the billing-side
// GET /api/v1/insurance/enhancement-justification-template, which is
// gated to ADMIN/BILLING_STAFF/INSURANCE_COORDINATOR — so the treating
// clinician who starts an enhancement from the chart could not fetch the
// template they were told to fill (the POST handler below points at it).
// Exposing it on this clinician-gated chart surface closes that gap.
// Finding 2026-05-20-tpa-insurance-claim-doctor-391174a0.
router.get('/template', (req, res) =>
  success(res, ENHANCEMENT_JUSTIFICATION_TEMPLATE, 'Enhancement justification template'),
);

// GET /api/v1/admissions/:admissionId/tpa-enhancement
//
// Returns the parent preauth + every enhancement child + the
// cumulative sanctioned total. Used by the chart panel to show the
// consultant "₹50,000 original + ₹30,000 enhancement = ₹80,000 cap"
// without forcing them into the billing module.
router.get('/', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const admissionId = Number(req.params.admissionId);
    if (!Number.isInteger(admissionId) || admissionId <= 0) {
      return error(res, 'Invalid admissionId', 400);
    }
    const parent = await resolveParentPreauth(tenantId, admissionId);
    if (!parent) {
      return success(res, {
        admission_id: admissionId,
        parent: null,
        enhancements: [],
        cumulative_approved: 0,
        cumulative_requested: 0,
      }, 'No active TPA preauth on this admission');
    }
    const bundle = await buildEnhancementChain(parent);
    return success(res, { admission_id: admissionId, ...bundle });
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('admission tpa-enhancement GET failed', { error: err.message });
    return error(res, 'Failed to read TPA enhancement chain', 500);
  }
});

// POST /api/v1/admissions/:admissionId/tpa-enhancement
//
// Body: { expected_cost, primary_diagnosis?, proposed_procedure?,
//         expected_los_days?, icd10_codes?, procedure_codes?,
//         clinical_justification? | justification? }
//
// Creates a child preauth (request_type='enhancement',
// parent_preauth_id=parent.id) under the admission's active parent
// preauth. The clinical justification can be a structured object
// matching the enhancement justification template (see
// GET /api/v1/insurance/enhancement-justification-template) or a legacy
// free-text `justification` string — either way it is normalised to a
// readable form and folded into `notes` so it lands on the
// clinical-justification side of the TPA submission.
router.post('/', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const admissionId = Number(req.params.admissionId);
    if (!Number.isInteger(admissionId) || admissionId <= 0) {
      return error(res, 'Invalid admissionId', 400);
    }

    const {
      expected_cost,
      justification,
      clinical_justification,
      primary_diagnosis,
      proposed_procedure,
      expected_los_days,
      icd10_codes,
      procedure_codes,
    } = req.body || {};

    let normalizedJustification;
    try {
      normalizedJustification = normalizeClinicalJustification(
        clinical_justification ?? justification,
      );
    } catch (e) {
      if (e.statusCode) return error(res, e.message, e.statusCode);
      throw e;
    }

    const parent = await resolveParentPreauth(tenantId, admissionId);
    if (!parent) {
      return error(res, 'No active TPA preauth on this admission to extend', 404);
    }
    if (['cancelled', 'lapsed', 'denied'].includes(parent.status)) {
      return error(res, `Parent preauth is ${parent.status}; cannot create enhancement`, 409);
    }

    const created = await claims.createPreauth({
      tenantId,
      policy_id: parent.policy_id,
      patient_uid: parent.patient_uid,
      admission_id: admissionId,
      request_type: 'enhancement',
      parent_preauth_id: parent.id,
      primary_diagnosis: primary_diagnosis || parent.primary_diagnosis,
      icd10_codes: icd10_codes || null,
      proposed_procedure: proposed_procedure || null,
      procedure_codes: procedure_codes || null,
      treating_doctor_uid: req.user?.uid || null,
      treating_doctor_name: req.user?.name || null,
      expected_los_days: expected_los_days || null,
      expected_cost,
      notes: normalizedJustification.text || null,
      created_by: req.user?.uid || null,
    });

    return success(
      res,
      {
        admission_id: admissionId,
        parent_preauth_id: parent.id,
        enhancement: created,
        clinical_justification: {
          format: normalizedJustification.format,
          structured: normalizedJustification.structured,
        },
      },
      'Enhancement preauth opened',
      201,
    );
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('admission tpa-enhancement POST failed', { error: err.message });
    return error(res, 'Failed to open enhancement preauth', 500);
  }
});

// POST /api/v1/admissions/:admissionId/tpa-enhancement/:preauthId/submit
//
// Submit a draft pre-auth (the original or an enhancement child) on this
// admission to the TPA. Closes finding
// 2026-05-20-tpa-insurance-claim-doctor-391174a0: a treating clinician
// could open an enhancement draft from the chart (POST above) but the
// submit + template endpoints lived only under /api/v1/insurance/*, which
// is gated to ADMIN / SUPER_ADMIN / BILLING_STAFF / INSURANCE_COORDINATOR
// — so the doctor was Forbidden from finishing the workflow they started.
// Exposing submit on this clinician-gated chart surface (keyed off
// admission_id) lets the consultant complete it without a billing hand-off.
// Delegates to the same claimsService.submitPreauth the billing route uses,
// so the doc-bundle attach + draft-status gate + SLA logic stay in one place.
router.post('/:preauthId/submit', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const admissionId = Number(req.params.admissionId);
    const preauthId = Number(req.params.preauthId);
    if (!Number.isInteger(admissionId) || admissionId <= 0) {
      return error(res, 'Invalid admissionId', 400);
    }
    if (!Number.isInteger(preauthId) || preauthId <= 0) {
      return error(res, 'Invalid preauthId', 400);
    }

    // The :preauthId is caller-supplied and not implied by the mount, so
    // confirm it belongs to THIS admission before submitting — otherwise a
    // clinician on admission A could submit admission B's pre-auth. 404
    // (not 403) so we don't disclose that pre-auths exist on other
    // admissions. getPreauth throws AppError.notFound for a missing id,
    // which the catch below maps to a clean 404.
    const pre = await claims.getPreauth({ tenantId, id: preauthId });
    if (Number(pre.admission_id) !== admissionId) {
      return error(res, 'Pre-auth does not belong to this admission', 404);
    }

    const submitted = await claims.submitPreauth({
      tenantId,
      id: preauthId,
      submitted_by: req.user?.uid || null,
      submission_channel: req.body?.submission_channel,
      tpa_reference_id: req.body?.tpa_reference_id,
    });

    return success(res, submitted, 'Pre-auth submitted to TPA');
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('admission tpa-enhancement submit failed', { error: err.message });
    return error(res, 'Failed to submit pre-auth', 500);
  }
});

export default router;
