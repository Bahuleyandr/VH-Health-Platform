// src/routes/emr/deviceVitalsRoutes.js
//
// Roadmap C5 — ICU monitor vitals. Mounted at /api/v1/devices (app.js).
//   POST /vitals/ingest        — monitor/gateway pushes ORU^R01
//   GET  /vitals/unverified    — ICU review queue
//   POST /vitals/:id/verify    — clinician verification (audited)

import express from 'express';
import logger from '../../logging/logger.js';
import {
  ingestDeviceVitals,
  listUnverifiedDeviceVitals,
  verifyDeviceVitals,
} from '../../services/emr/deviceVitalsService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isClinical, isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canVerify = (role) => isClinical(role) || isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Device vitals ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.post('/vitals/ingest', async (req, res) => {
  try {
    const result = await ingestDeviceVitals({
      message: req.body.message,
      deviceCode: req.body.device_code || null,
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    return success(res, result, 'Device vitals ingested (unverified)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'ingest device vitals');
  }
});

router.get('/vitals/unverified', async (req, res) => {
  try {
    const rows = await listUnverifiedDeviceVitals({
      patientUid: req.query.patient_uid || null,
      limit: req.query.limit,
    });
    return success(res, { vitals: rows, count: rows.length }, 'Unverified device vitals');
  } catch (err) {
    return handleFailure(res, err, 'list unverified device vitals');
  }
});

router.post('/vitals/:id/verify', async (req, res) => {
  try {
    if (!canVerify(req.user?.role)) {
      return error(res, 'Only clinical staff can verify device vitals', HTTP_STATUS.FORBIDDEN);
    }
    const row = await verifyDeviceVitals(Number.parseInt(req.params.id, 10), {
      actorUid: req.user?.uid || null, actorRole: req.user?.role || null,
    });
    return success(res, { vitals: row }, 'Device vitals verified');
  } catch (err) {
    return handleFailure(res, err, 'verify device vitals');
  }
});

export default router;
