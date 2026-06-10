// src/routes/clinical/problemListRoutes.js
//
// Roadmap B7 — longitudinal problem list. Mounted at /api/v1/problems
// behind the clinical-staff gate + PHI logger (see app.js). Reads serve all
// clinical staff; writes are doctor/admin actions (nurses chart against
// problems but do not own the list).

import express from 'express';
import logger from '../../logging/logger.js';
import {
  listProblems,
  getProblem,
  createProblem,
  updateProblem,
  promoteDiagnosis,
} from '../../services/clinical/problemListService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canEditProblems = (role) => isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Problem list ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/patient/:patientUid', async (req, res) => {
  try {
    const problems = await listProblems(req.params.patientUid, {
      status: req.query.status || null,
    });
    return success(res, { problems, count: problems.length }, 'Patient problem list');
  } catch (err) {
    return handleFailure(res, err, 'list problems');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const problem = await getProblem(req.params.id);
    if (!problem) return error(res, 'Problem not found', HTTP_STATUS.NOT_FOUND);
    return success(res, { problem }, 'Problem');
  } catch (err) {
    return handleFailure(res, err, 'fetch problem');
  }
});

router.post('/', async (req, res) => {
  try {
    if (!canEditProblems(req.user?.role)) {
      return error(res, 'Only doctors or admins can record problems', HTTP_STATUS.FORBIDDEN);
    }
    const result = await createProblem({
      patientUid: req.body.patient_uid,
      title: req.body.title,
      icd10Code: req.body.icd10_code || null,
      snomedCode: req.body.snomed_code || null,
      severity: req.body.severity || null,
      isChronic: req.body.is_chronic === true,
      onsetDate: req.body.onset_date || null,
      managingDoctor: req.body.managing_doctor ?? null,
      sourceEncounterId: req.body.source_encounter_id || null,
      notes: req.body.notes || null,
      codings: Array.isArray(req.body.codings) ? req.body.codings : [],
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, result, 'Problem recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record problem');
  }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!canEditProblems(req.user?.role)) {
      return error(res, 'Only doctors or admins can update problems', HTTP_STATUS.FORBIDDEN);
    }
    const problem = await updateProblem(req.params.id, {
      status: req.body.status,
      title: req.body.title,
      severity: req.body.severity,
      isChronic: typeof req.body.is_chronic === 'boolean' ? req.body.is_chronic : undefined,
      onsetDate: req.body.onset_date,
      resolvedDate: req.body.resolved_date,
      resolutionNotes: req.body.resolution_notes,
      notes: req.body.notes,
      snomedCode: req.body.snomed_code,
      managingDoctor: req.body.managing_doctor,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, { problem }, 'Problem updated');
  } catch (err) {
    return handleFailure(res, err, 'update problem');
  }
});

// Promote a per-visit diagnosis row onto the longitudinal list (idempotent).
router.post('/promote/:diagnosisId', async (req, res) => {
  try {
    if (!canEditProblems(req.user?.role)) {
      return error(res, 'Only doctors or admins can promote diagnoses', HTTP_STATUS.FORBIDDEN);
    }
    const result = await promoteDiagnosis(req.params.diagnosisId, {
      isChronic: req.body?.is_chronic === true,
      managingDoctor: req.body?.managing_doctor ?? null,
      notes: req.body?.notes ?? null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    const status = result.already_active ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
    return success(res, result, result.already_active ? 'Problem already active' : 'Diagnosis promoted to problem list', status);
  } catch (err) {
    return handleFailure(res, err, 'promote diagnosis');
  }
});

export default router;
