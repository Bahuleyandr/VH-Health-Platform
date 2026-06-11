// src/routes/clinical/medRecRoutes.js
//
// Roadmap B6 — three-point medication reconciliation. Mounted at
// /api/v1/med-rec behind the clinical-staff gate + PHI logger (app.js).
// Reads serve clinical staff; decisions are doctor/pharmacist/admin work.

import express from 'express';
import logger from '../../logging/logger.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  startReconciliation,
  getReconciliation,
  listReconciliations,
  decideItem,
  completeReconciliation,
} from '../../services/clinical/medicationReconciliationService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const MEDREC_DECIDER_ROLES = [ROLES.PHARMACY_STAFF, ROLES.PHARMACY_INCHARGE, 'SUPER_ADMIN'];
const canDecide = (role) => isDoctor(role) || isAdmin(role) || MEDREC_DECIDER_ROLES.includes(role);
const guardMedRecView = patientAccessGuard('MED_REC', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardMedRecWrite = patientAccessGuard('MED_REC', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});
const guardMedRecResourceView = patientAccessGuardForResource('MED_REC', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'medication_reconciliation',
});
const guardMedRecResourceWrite = patientAccessGuardForResource('MED_REC', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'medication_reconciliation',
});

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Med-rec ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.post('/start', guardMedRecWrite, async (req, res) => {
  try {
    if (!canDecide(req.user?.role)) {
      return error(res, 'Only doctors, pharmacists or admins can start a reconciliation', HTTP_STATUS.FORBIDDEN);
    }
    const rec = await startReconciliation({
      patientUid: req.body.patient_uid,
      recType: req.body.rec_type,
      admissionId: req.body.admission_id ?? null,
      encounterId: req.body.encounter_id ?? null,
      transferContext: req.body.transfer_context ?? null,
      notes: req.body.notes ?? null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    return success(res, { reconciliation: rec }, 'Reconciliation started', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'start reconciliation');
  }
});

router.get('/patient/:patientUid', guardMedRecView, async (req, res) => {
  try {
    const recs = await listReconciliations(req.params.patientUid, {
      tenantId: req.tenantId,
      recType: req.query.rec_type || null,
    });
    return success(res, { reconciliations: recs, count: recs.length }, 'Patient reconciliations');
  } catch (err) {
    return handleFailure(res, err, 'list reconciliations');
  }
});

router.get('/:id', guardMedRecResourceView, async (req, res) => {
  try {
    const rec = await getReconciliation(req.params.id, { tenantId: req.tenantId });
    if (!rec) return error(res, 'Reconciliation not found', HTTP_STATUS.NOT_FOUND);
    return success(res, { reconciliation: rec }, 'Reconciliation');
  } catch (err) {
    return handleFailure(res, err, 'fetch reconciliation');
  }
});

router.patch('/:id/items/:itemId', guardMedRecResourceWrite, async (req, res) => {
  try {
    if (!canDecide(req.user?.role)) {
      return error(res, 'Only doctors, pharmacists or admins can decide medications', HTTP_STATUS.FORBIDDEN);
    }
    const item = await decideItem(req.params.id, Number.parseInt(req.params.itemId, 10), {
      decision: req.body.decision,
      reason: req.body.reason ?? null,
      newInstructions: req.body.new_instructions ?? null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    return success(res, { item }, 'Item decided');
  } catch (err) {
    return handleFailure(res, err, 'decide item');
  }
});

router.post('/:id/complete', guardMedRecResourceWrite, async (req, res) => {
  try {
    if (!canDecide(req.user?.role)) {
      return error(res, 'Only doctors, pharmacists or admins can complete a reconciliation', HTTP_STATUS.FORBIDDEN);
    }
    const rec = await completeReconciliation(req.params.id, {
      actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId,
    });
    return success(res, { reconciliation: rec }, 'Reconciliation completed');
  } catch (err) {
    return handleFailure(res, err, 'complete reconciliation');
  }
});

export default router;
