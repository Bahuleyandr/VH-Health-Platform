// src/routes/clinical/problemListRoutes.js
//
// Roadmap B7 — longitudinal problem list. Mounted at /api/v1/problems
// behind the clinical-staff gate + PHI logger (see app.js). Reads serve all
// clinical staff; writes are doctor/admin actions (nurses chart against
// problems but do not own the list).

import express from 'express';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  listProblems,
  getProblem,
  createProblem,
  updateProblem,
  promoteDiagnosis,
} from '../../services/clinical/problemListService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canEditProblems = (role) => isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';
const guardProblemView = patientAccessGuard('PROBLEM_LIST', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardProblemWrite = patientAccessGuard('PROBLEM_LIST', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});
const guardProblemResourceView = patientAccessGuardForResource('PROBLEM_LIST', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'patient_problem',
});
const guardProblemResourceWrite = patientAccessGuardForResource('PROBLEM_LIST', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'patient_problem',
});
const guardDiagnosisPromotionWrite = patientAccessGuardForResource('DIAGNOSIS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'diagnosis',
  idParam: 'diagnosisId',
});

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.get('/patient/:patientUid', guardProblemView, async (req, res) => {
  try {
    const problems = await listProblems(req.params.patientUid, {
      tenantId: req.tenantId,
      status: req.query.status || null,
    });
    return success(res, { problems, count: problems.length }, 'Patient problem list');
  } catch (err) {
    return handleFailure(res, err, 'list problems');
  }
});

router.get('/:id', guardProblemResourceView, async (req, res) => {
  try {
    const problem = await getProblem(req.params.id, { tenantId: req.tenantId });
    if (!problem) return error(res, 'Problem not found', HTTP_STATUS.NOT_FOUND);
    return success(res, { problem }, 'Problem');
  } catch (err) {
    return handleFailure(res, err, 'fetch problem');
  }
});

router.post('/', guardProblemWrite, async (req, res) => {
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
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    return success(res, result, 'Problem recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record problem');
  }
});

router.patch('/:id', guardProblemResourceWrite, async (req, res) => {
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
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    return success(res, { problem }, 'Problem updated');
  } catch (err) {
    return handleFailure(res, err, 'update problem');
  }
});

// Promote a per-visit diagnosis row onto the longitudinal list (idempotent).
router.post('/promote/:diagnosisId', guardDiagnosisPromotionWrite, async (req, res) => {
  try {
    if (!canEditProblems(req.user?.role)) {
      return error(res, 'Only doctors or admins can promote diagnoses', HTTP_STATUS.FORBIDDEN);
    }
    const result = await promoteDiagnosis(req.params.diagnosisId, {
      isChronic: req.body?.is_chronic === true,
      managingDoctor: req.body?.managing_doctor ?? null,
      notes: req.body?.notes ?? null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    const status = result.already_active ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
    return success(res, result, result.already_active ? 'Problem already active' : 'Diagnosis promoted to problem list', status);
  } catch (err) {
    return handleFailure(res, err, 'promote diagnosis');
  }
});

export default router;
