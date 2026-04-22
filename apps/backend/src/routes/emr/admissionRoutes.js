// src/routes/emr/admissionRoutes.js
// ADT (Admission/Discharge/Transfer) routes — mounted at /api/v1/emr

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import admissionService from '../../services/emr/admissionService.js';
import dischargeSummaryGenerator from '../../services/emr/dischargeSummaryGenerator.js';
import {
  generateAdmissionAiDraft,
  generateWardRoundBrief,
} from '../../services/ai/clinicalAiWorkflowService.js';
import {
  listTranslations,
  translateGeneration,
} from '../../services/ai/translationService.js';
import { success, error } from '../../utils/responseHelper.js';
import { canEditDischargeSummary, canSignDischargeSummary } from '../../utils/roleHelpers.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// GET /clinical-ai/config - Clinical AI provider status
// ---------------------------------------------------------------------------
router.get(
  '/clinical-ai/config',
  wrapAsync(async (_req, res) => {
    success(res, dischargeSummaryGenerator.getDischargeSummaryAiConfig(), 'Clinical AI config retrieved');
  })
);

// ---------------------------------------------------------------------------
// POST /admit — Admit a patient
// ---------------------------------------------------------------------------
router.post(
  '/admit',
  wrapAsync(async (req, res) => {
    const data = {
      ...req.body,
      created_by: req.user?.uid,
    };

    const admission = await admissionService.admitPatient(data);
    success(res, { admission }, 'Patient admitted successfully', HTTP_STATUS.CREATED);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge — Discharge a patient
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const dischargedBy = req.user?.uid;
    const dischargeData = req.body;

    const admission = await admissionService.dischargePatient(admissionId, dischargeData, dischargedBy);
    success(res, { admission }, 'Patient discharged successfully');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/transfer — Transfer a patient
// ---------------------------------------------------------------------------
router.post(
  '/:id/transfer',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { to_ward_id, to_bed_id, reason } = req.body;
    const transferredBy = req.user?.uid;

    if (!to_bed_id) {
      return error(res, 'to_bed_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const admission = await admissionService.transferPatient(
      admissionId,
      to_ward_id || null,
      parseInt(to_bed_id, 10),
      reason || null,
      transferredBy
    );
    success(res, { admission }, 'Patient transferred successfully');
  })
);

// ---------------------------------------------------------------------------
// GET /admissions — List active admissions (with filters)
// ---------------------------------------------------------------------------
router.get(
  '/admissions',
  wrapAsync(async (req, res) => {
    const { ward, doctor, department, status, page, limit } = req.query;
    const result = await admissionService.getActiveAdmissions({
      ward, doctor, department, status,
      page: page || 1,
      limit: limit || 20,
    });
    success(res, result.admissions, 'Active admissions retrieved', HTTP_STATUS.OK, { pagination: result.pagination });
  })
);

// ---------------------------------------------------------------------------
// GET /admissions/stats — Admission statistics
// ---------------------------------------------------------------------------
router.get(
  '/admissions/stats',
  wrapAsync(async (req, res) => {
    const { date_from, date_to } = req.query;
    const stats = await admissionService.getAdmissionStats(date_from || null, date_to || null);
    success(res, stats, 'Admission statistics retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /admissions/patient/:uid — Patient admission history
// ---------------------------------------------------------------------------
router.get(
  '/admissions/patient/:uid',
  wrapAsync(async (req, res) => {
    const { uid } = req.params;
    const history = await admissionService.getPatientAdmissionHistory(uid);
    success(res, { admissions: history, count: history.length }, 'Patient admission history retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /admission/:id — Admission detail
// ---------------------------------------------------------------------------
router.get(
  '/admission/:id',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const admission = await admissionService.getAdmissionDetail(admissionId, {
      userId: req.user?.uid,
      userRole: req.user?.role,
      ip: req.ip,
      requestId: req.id,
    });
    success(res, { admission }, 'Admission detail retrieved');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/code-status — Update code status (DNR, etc.)
// ---------------------------------------------------------------------------
router.put(
  '/:id/code-status',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { code_status } = req.body;
    if (!code_status) {
      return error(res, 'code_status is required', HTTP_STATUS.BAD_REQUEST);
    }

    const updatedBy = req.user?.uid;
    const admission = await admissionService.updateCodeStatus(admissionId, code_status, updatedBy);
    success(res, { admission }, 'Code status updated');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/attending-doctor — Change attending physician
// ---------------------------------------------------------------------------
router.put(
  '/:id/attending-doctor',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { doctor_uid } = req.body;
    if (!doctor_uid) {
      return error(res, 'doctor_uid is required', HTTP_STATUS.BAD_REQUEST);
    }

    const updatedBy = req.user?.uid;
    const admission = await admissionService.updateAttendingDoctor(admissionId, doctor_uid, updatedBy);
    success(res, { admission }, 'Attending doctor updated');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge-summary/generate — Auto-generate discharge summary
// Roles: DOCTOR, MEDICAL_RECORDS, ADMIN (not PHARMACY, HR, GENERAL)
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/generate',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canEditDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'You do not have permission to generate discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const summary = await dischargeSummaryGenerator.generateDischargeSummary(
      admissionId,
      req.user?.uid,
      req
    );

    success(res, { discharge_summary: summary, is_draft: true },
      'Discharge summary generated (draft — requires doctor review and signature)');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/discharge-summary — Save/edit discharge summary draft
// Roles: DOCTOR, MEDICAL_RECORDS, ADMIN (not PHARMACY, HR, NURSING, GENERAL)
// ---------------------------------------------------------------------------
router.put(
  '/:id/discharge-summary',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canEditDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'You do not have permission to edit discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { discharge_summary } = req.body;
    if (!discharge_summary) {
      return error(res, 'discharge_summary is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await dischargeSummaryGenerator.saveDischargeSummary(
      admissionId,
      discharge_summary,
      req.user?.uid
    );

    success(res, result, `Discharge summary ${result.action} (still a draft — requires doctor signature)`);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge-summary/sign — Doctor signs the discharge summary
// Roles: DOCTOR only (SUPER_ADMIN can override)
// Medical Records can generate/edit but NOT sign — only doctors sign.
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/sign',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canSignDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'Only doctors can sign discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const doctorUid = req.user?.uid;
    const result = await dischargeSummaryGenerator.signDischargeSummary(admissionId, doctorUid);

    success(res, result, 'Discharge summary signed — now official and immutable');
  })
);

// ---------------------------------------------------------------------------
// Modular Clinical AI draft routes (admission-scoped).
// The top-level /api/v1/emr gate already restricts access to CLINICAL_STAFF_ROLES.
// Each module enforces enablement + reviewRoles inside the workflow service.
// ---------------------------------------------------------------------------
function parseAdmissionId(req, res) {
  const admissionId = parseInt(req.params.id, 10);
  if (Number.isNaN(admissionId)) {
    error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    return null;
  }
  return admissionId;
}

async function respondWithAdmissionAiDraft(req, res, moduleKey, message) {
  const admissionId = parseAdmissionId(req, res);
  if (admissionId === null) return;

  const draft = await generateAdmissionAiDraft(admissionId, moduleKey, req.user?.uid || null, req);
  success(res, draft, message);
}

router.post(
  '/:id/ai/patient-record-summary',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'patient_record_summary', 'Patient record summary draft generated')
  )
);

router.post(
  '/:id/aftercare-instructions',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'patient_aftercare_instructions', 'Aftercare instructions draft generated')
  )
);

router.post(
  '/:id/medication-reconciliation',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'medication_reconciliation', 'Medication reconciliation draft generated')
  )
);

router.get(
  '/:id/discharge-readiness',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'discharge_readiness', 'Discharge readiness draft generated')
  )
);

router.post(
  '/:id/referral-letter',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'referral_letter', 'Referral letter draft generated')
  )
);

router.post(
  '/:id/abnormal-result-triage',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'abnormal_result_triage', 'Abnormal result triage draft generated')
  )
);

router.post(
  '/:id/clinical-coding-assist',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'clinical_coding_assist', 'Clinical coding assist draft generated')
  )
);

router.post(
  '/:id/quality-case-review',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'quality_case_review', 'Quality case review draft generated')
  )
);

// POST /ward-round-brief — aggregate draft across admitted patients.
router.post(
  '/ward-round-brief',
  wrapAsync(async (req, res) => {
    const draft = await generateWardRoundBrief({
      ward: req.body?.ward || req.query?.ward || null,
      limit: req.body?.limit || req.query?.limit,
      requestedBy: req.user?.uid || null,
      req,
    });
    success(res, draft, 'Daily ward round brief draft generated');
  })
);

// Translate an accepted generation into the patient's preferred language.
// Only reviewer-accepted generations are translated — enforced in the
// service. Multilingual rendering of unreviewed drafts is prohibited.
router.post(
  '/generations/:generationId/translate',
  wrapAsync(async (req, res) => {
    const result = await translateGeneration({
      generationId: req.params.generationId,
      targetLanguage: req.body?.target_language || req.query?.target_language,
      requestedBy: req.user?.uid || null,
      req,
    });
    success(res, result, 'Translation ready');
  })
);

// List translations (tenant-scoped). Optional ?language=hi.
router.get(
  '/translations',
  wrapAsync(async (req, res) => {
    const result = await listTranslations({
      tenantId: req.tenantId,
      targetLanguage: req.query?.language || null,
      limit: req.query?.limit,
    });
    success(res, result, 'Translations retrieved');
  })
);

export default router;
