// src/routes/radiology/pacsRoutes.js
//
// Roadmap B4 — PACS/viewer surface. Mounted at /api/v1/pacs behind the
// clinical-staff gate + PHI logger (app.js).

import express from 'express';
import logger from '../../logging/logger.js';
import {
  getPacsConfig,
  linkStudy,
  listPatientStudies,
  buildModalityWorklist,
} from '../../services/radiology/pacsService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`PACS ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
router.post('/orders/:orderId/link-study', async (req, res) => {
  try {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, 'Invalid order id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await linkStudy(orderId, {
      studyInstanceUid: req.body.study_instance_uid,
      accessionNumber: req.body.accession_number || null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, result, 'Study linked to order', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'link study');
  }
});

// Linked studies for a patient (with OHIF deep links).
router.get('/studies/patient/:patientUid', async (req, res) => {
  try {
    const studies = await listPatientStudies(req.params.patientUid);
    return success(res, { studies, count: studies.length }, 'Patient imaging studies');
  } catch (err) {
    return handleFailure(res, err, 'list patient studies');
  }
});

// MWL-shaped feed for the Orthanc worklist sidecar.
router.get('/worklist', async (req, res) => {
  try {
    const items = await buildModalityWorklist({
      modality: req.query.modality || null,
      limit: req.query.limit,
    });
    return success(res, { items, count: items.length }, 'Modality worklist');
  } catch (err) {
    return handleFailure(res, err, 'build modality worklist');
  }
});

export default router;
