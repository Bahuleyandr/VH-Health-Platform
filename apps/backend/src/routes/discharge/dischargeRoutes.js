// src/routes/discharge/dischargeRoutes.js
//
// Sprint 11 — discharge summary builder. Mounted at
// /api/v1/discharge-summaries/*.

import { Router } from 'express';
import * as discharge from '../../services/discharge/dischargeService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff, isDoctor } from '../../utils/roleHelpers.js';
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
router.get('/templates', requireStaffOrAdmin, wrap(async (req) =>
  discharge.listTemplates({
    tenantId: tenantOf(req),
    specialty: req.query.specialty,
  }),
));

// ── Summaries ────────────────────────────────────────────────────────
router.post('/', requireStaffOrAdmin, wrap(async (req) =>
  discharge.createDraft({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
  }),
));

router.get('/pending', requireStaffOrAdmin, wrap(async (req) =>
  discharge.listPending({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.get('/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  discharge.listForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
    limit: req.query.limit,
  }),
));

router.get('/admission/:admissionId/pdf', requireStaffOrAdmin, wrap(async (req, res) =>
  sendDischargeSummaryPdf(req, res, { admissionId: req.params.admissionId }),
));

router.get('/:id/pdf', requireStaffOrAdmin, wrap(async (req, res) =>
  sendDischargeSummaryPdf(req, res, { id: req.params.id }),
));

router.get('/:id', requireStaffOrAdmin, wrap(async (req) =>
  discharge.getOne({ tenantId: tenantOf(req), id: req.params.id }),
));

router.patch('/:id/sections/:key', requireStaffOrAdmin, wrap(async (req) =>
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
router.patch('/:id/codes', requireStaffOrAdmin, wrap(async (req) =>
  discharge.updateDraftCodes({
    tenantId: tenantOf(req),
    id: req.params.id,
    icd10_codes: req.body.icd10_codes,
    updated_by: req.user?.uid,
  }),
));

router.post('/:id/ready', requireStaffOrAdmin, wrap(async (req) =>
  discharge.markReadyForSignoff({
    tenantId: tenantOf(req),
    id: req.params.id,
    marked_by: req.user?.uid,
  }),
));

router.post('/:id/sign', requireDoctorOrAdmin, wrap(async (req) =>
  discharge.sign({
    tenantId: tenantOf(req),
    id: req.params.id,
    signed_by: req.user?.uid,
    signed_by_name: req.body.signed_by_name || req.user?.name,
    signed_by_reg: req.body.signed_by_reg,
  }),
));

router.post('/:id/deliver', requireStaffOrAdmin, wrap(async (req) =>
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
router.patch('/:id/sections/:key/translation', requireStaffOrAdmin, wrap(async (req) =>
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
