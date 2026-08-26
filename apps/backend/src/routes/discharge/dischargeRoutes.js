// src/routes/discharge/dischargeRoutes.js
//
// Sprint 11 — discharge summary builder. Mounted at
// /api/v1/discharge-summaries/*.

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import * as discharge from '../../services/discharge/dischargeService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff, isDoctor } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { positiveIntOrNull } from '../../middleware/routePatientAccessGuards.js';

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
      return relayAppError(res, err, 'Discharge summary error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireDoctorOrAdmin(req, res, next) {
  if (!isDoctor(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Doctor or admin role required for sign-off', 403);
  }
  next();
}

// ── Patient-access guards (re-audit 2026-08, M: mount guards) ────────
//
// The DISCHARGE_SUMMARY patientAccessGuard used to sit on the app.js mount.
// A mount-level middleware runs BEFORE Express matches the route, so
// req.params is empty there; the single-subject routes in this file carry
// the patient only behind :id / :admissionId / :patientUid path params, so
// resolvePatientForAccess found nothing and authorizePatientAccessRequest
// returned no_patient_context without evaluating a policy — in shadow AND in
// enforce. The mount guard DID read req.body, which is worse, not better: a
// body-supplied decoy patient_uid on a write (e.g. PATCH /:id/sections/:key)
// could be authorised while the handler served the summary behind :id.
//
// The guard now sits on each single-subject route with an explicit
// patientSelector that resolves THE ROW THE HANDLER IS ABOUT TO SERVE,
// tenant-scoped, from the same identifier the handler passes to
// dischargeService (same pattern as bcmaRoutes.guardWristbandView and the
// abdmHiuRoutes selector factories). requirePatientContext refuses instead
// of falling back when the selector yields nothing:
// discharge_summaries.patient_uid is NOT NULL and createDraft rejects a
// missing patient_uid, so a missing subject means a malformed id or a
// missing/foreign record, never a legitimately subject-less request. In
// shadow mode the refusal (like every denial) is audit-only.
//
// GET /templates (template catalogue) and GET /pending (cross-patient
// worklist) have no single patient subject and deliberately keep the role
// gate only — a patient guard there has no subject to resolve and would be a
// control that can never fire.
//
// Mode governance is carried over from the mount unchanged:
// careTeamModeGoverned stays true, so the per-tenant
// care_team_enforcement_mode flag ('shadow' by default) governs these
// routes. DISCHARGE_SUMMARY resolves to the patient.clinical_document.view
// policy (accessPolicyRegistry.policyCodeForRecordType).

// Delegates to the shared int4-capped parser. The local copy lacked the
// int4 cap, so a 10-digit id reached the ::int bind and threw 22003 —
// a guard 500 on malformed input, violating the never-throw contract.
function positiveInt(value) {
  return positiveIntOrNull(value);
}

const dischargeGuard = (patientSelector) => patientAccessGuard('DISCHARGE_SUMMARY', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  requireResolvedPatient: true,
  patientSelector,
});

// The patient behind discharge_summaries.:id — the row every /:id handler
// loads. A malformed id returns null (clean refusal), never a throw.
const patientFromSummaryId = async (req) => {
  const summaryId = positiveInt(req.params?.id);
  if (summaryId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    summaryId,
  );
  return rows[0] ?? null;
};

const guardSummaryById = dischargeGuard(patientFromSummaryId);

// GET /admission/:admissionId/pdf resolves its summary through the admission
// row — the subject is that admission's patient, exactly the linkage
// generateSignedDischargeSummaryPdfBuffer serves.
const guardSummaryByAdmissionId = dischargeGuard(async (req) => {
  const admissionId = positiveInt(req.params?.admissionId);
  if (admissionId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM admissions
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    admissionId,
  );
  return rows[0] ?? null;
});

// GET /patient/:patientUid names the subject directly in the path — bind the
// selector to that same param so the decision, the audit row and the listing
// are the same patient by construction.
const guardSummariesByPatientParam = dischargeGuard((req) => ({ uid: req.params?.patientUid }));

// POST / carries the subject only in the body — resolve it exactly the way
// createDraft will (body.patient_uid, required by the service).
const guardSummaryCreate = dischargeGuard((req) => ({ uid: req.body?.patient_uid }));

async function sendDischargeSummaryPdf(req, res, target) {
  const result = await discharge.generateSignedDischargeSummaryPdfBuffer({
    tenantId: tenantOf(req),
    actorUid: req.user?.uid,
    requestId: req.id,
    ...target,
  });
  const filename = `discharge-summary-${result.summary.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(result.buffer.length));
  return res.send(result.buffer);
}

// ── Templates ────────────────────────────────────────────────────────
// Template catalogue — no patient subject; role gate only.
router.get('/templates', requireStaffOrAdmin, wrap(async (req) =>
  discharge.listTemplates({
    tenantId: tenantOf(req),
    specialty: req.query.specialty,
  }),
));

// ── Summaries ────────────────────────────────────────────────────────
router.post('/', requireStaffOrAdmin, guardSummaryCreate, wrap(async (req) =>
  discharge.createDraft({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
  }),
));

// Cross-patient sign-off worklist — no single patient subject; role gate
// only (see the guard block comment above).
router.get('/pending', requireStaffOrAdmin, wrap(async (req) =>
  discharge.listPending({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.get('/patient/:patientUid', requireStaffOrAdmin, guardSummariesByPatientParam, wrap(async (req) =>
  discharge.listForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
    limit: req.query.limit,
  }),
));

router.get('/admission/:admissionId/pdf', requireStaffOrAdmin, guardSummaryByAdmissionId, wrap(async (req, res) =>
  sendDischargeSummaryPdf(req, res, { admissionId: req.params.admissionId }),
));

router.get('/:id/pdf', requireStaffOrAdmin, guardSummaryById, wrap(async (req, res) =>
  sendDischargeSummaryPdf(req, res, { id: req.params.id }),
));

router.get('/:id', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.getOne({ tenantId: tenantOf(req), id: req.params.id }),
));

router.patch('/:id/sections/:key', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.updateSection({
    tenantId: tenantOf(req),
    id: req.params.id,
    section_key: req.params.key,
    body: req.body.body,
    edited_by: req.user?.uid,
  }),
));

// Replace the draft's ICD-10 code list (WP2 coding enforcement + structured
// clinical_code_bindings mirror). Draft/ready-for-signoff only.
router.patch('/:id/codes', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.updateDraftCodes({
    tenantId: tenantOf(req),
    id: req.params.id,
    icd10_codes: req.body.icd10_codes,
    updated_by: req.user?.uid,
  }),
));

router.post('/:id/ready', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.markReadyForSignoff({
    tenantId: tenantOf(req),
    id: req.params.id,
    marked_by: req.user?.uid,
  }),
));

router.post('/:id/sign', requireDoctorOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.sign({
    tenantId: tenantOf(req),
    id: req.params.id,
    signed_by: req.user?.uid,
    signed_by_name: req.body.signed_by_name || req.user?.name,
    signed_by_reg: req.body.signed_by_reg,
  }),
));

router.post('/:id/deliver', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.markDelivered({
    tenantId: tenantOf(req),
    id: req.params.id,
    delivery_method: req.body.delivery_method,
    delivered_by: req.user?.uid,
  }),
));

// Set (or request) a per-section translation. Omitting `body` stores
// the translation-review placeholder so the section is queued for a
// human translator rather than silently staying English. Never
// machine-translates clinical text.
router.patch('/:id/sections/:key/translation', requireStaffOrAdmin, guardSummaryById, wrap(async (req) =>
  discharge.setSectionTranslation({
    tenantId: tenantOf(req),
    id: req.params.id,
    section_key: req.params.key,
    language: req.body.language,
    body: req.body.body,
    edited_by: req.user?.uid,
  }),
));

export default router;
