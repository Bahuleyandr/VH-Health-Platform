// src/routes/radiology/pacsRoutes.js
//
// Roadmap B4 — PACS/viewer surface. Mounted at /api/v1/pacs behind the
// clinical-staff gate + PHI logger (app.js).

import express from 'express';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import {
  getPacsConfig,
  linkStudy,
  listPatientStudies,
  buildModalityWorklist,
} from '../../services/radiology/pacsService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();

const guardPacsView = patientAccessGuard('RADIOLOGY_PACS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardPacsOrderWrite = patientAccessGuardForResource('RADIOLOGY_PACS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'radiology_order',
  idParam: 'orderId',
});

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

// Viewer/DICOMweb config for the staff app + admin embeds.
router.get('/config', async (req, res) => {
  try {
    return success(res, getPacsConfig(), 'PACS configuration');
  } catch (err) {
    return handleFailure(res, err, 'read PACS config');
  }
});

// Pin a PACS study to a radiology order (Orthanc Lua/webhook or manual).
router.post('/orders/:orderId/link-study', guardPacsOrderWrite, async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await linkStudy(orderId, {
      studyInstanceUid: req.body.study_instance_uid,
      accessionNumber: req.body.accession_number || null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: req.tenantId });
    return success(res, result, 'Study linked to order', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'link study');
  }
});

// Linked studies for a patient (with OHIF deep links).
router.get('/studies/patient/:patientUid', guardPacsView, async (req, res) => {
  try {
    const studies = await listPatientStudies(req.params.patientUid, { tenantId: req.tenantId });
    return success(res, { studies, count: studies.length }, 'Patient imaging studies');
  } catch (err) {
    return handleFailure(res, err, 'list patient studies');
  }
});

// MWL-shaped feed for the Orthanc worklist sidecar.
router.get('/worklist', async (req, res) => {
  try {
    const items = await buildModalityWorklist({
      tenantId: req.tenantId,
      modality: req.query.modality || null,
      limit: req.query.limit,
    });
    return success(res, { items, count: items.length }, 'Modality worklist');
  } catch (err) {
    return handleFailure(res, err, 'build modality worklist');
  }
});

export default router;
