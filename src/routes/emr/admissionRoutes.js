// src/routes/emr/admissionRoutes.js
// ADT (Admission/Discharge/Transfer) routes — mounted at /api/v1/emr

import express from 'express';
import logger from '../../logging/logger.js';
import admissionService from '../../services/emr/admissionService.js';
import dischargeSummaryGenerator from '../../services/emr/dischargeSummaryGenerator.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

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
// Aggregates all clinical data (notes, vitals, investigations, medications,
// diagnoses) and generates a structured draft. Optionally uses a local AI
// model for narrative summarization if AI_SUMMARIZE_URL is configured.
// The generated summary is ALWAYS a draft — must be signed by a doctor.
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/generate',
  wrapAsync(async (req, res) => {
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
// The summary can be edited freely until it is signed.
// ---------------------------------------------------------------------------
router.put(
  '/:id/discharge-summary',
  wrapAsync(async (req, res) => {
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
// Once signed, the summary becomes immutable. Only addenda are allowed after.
// Only doctors can sign. This is the final step before discharge.
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/sign',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const doctorUid = req.user?.uid;
    const result = await dischargeSummaryGenerator.signDischargeSummary(admissionId, doctorUid);

    success(res, result, 'Discharge summary signed — now official and immutable');
  })
);

export default router;
