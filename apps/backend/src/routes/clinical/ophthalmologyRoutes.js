// src/routes/clinical/ophthalmologyRoutes.js
//
// Roadmap D7 — ophthalmology exams + refractions. Mounted at
// /api/v1/ophthalmology (app.js) behind clinical-staff RBAC + PHI logging.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  recordExam,
  addRefraction,
  getPatientHistory,
} from '../../services/clinical/ophthalmologyService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Ophthalmology ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.user?.tenantId || req?.tenant?.id || null;

router.post('/exams', async (req, res) => {
  try {
    const exam = await recordExam({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      examType: req.body.exam_type || 'comprehensive',
      odVaUnaided: req.body.od_va_unaided ?? null,
      osVaUnaided: req.body.os_va_unaided ?? null,
      odVaPinhole: req.body.od_va_pinhole ?? null,
      osVaPinhole: req.body.os_va_pinhole ?? null,
      odVaCorrected: req.body.od_va_corrected ?? null,
      osVaCorrected: req.body.os_va_corrected ?? null,
      odIopMmhg: req.body.od_iop_mmhg ?? null,
      osIopMmhg: req.body.os_iop_mmhg ?? null,
      iopMethod: req.body.iop_method || null,
      odAnteriorSegment: req.body.od_anterior_segment || null,
      osAnteriorSegment: req.body.os_anterior_segment || null,
      odPosteriorSegment: req.body.od_posterior_segment || null,
      osPosteriorSegment: req.body.os_posterior_segment || null,
      odLensStatus: req.body.od_lens_status || null,
      osLensStatus: req.body.os_lens_status || null,
      diagnosis: req.body.diagnosis || null,
      advice: req.body.advice || null,
    }, ctx(req));
    return success(res, { exam }, exam.iop_alert ? 'Exam recorded — IOP above threshold' : 'Exam recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record exam');
  }
});

router.post('/exams/:id/refractions', async (req, res) => {
  try {
    const refraction = await addRefraction(req.params.id, {
      tenantId: tenantOf(req),
      eye: req.body.eye,
      refractionType: req.body.refraction_type || 'manifest',
      sphere: req.body.sphere,
      cylinder: req.body.cylinder ?? null,
      axis: req.body.axis ?? null,
      addPower: req.body.add_power ?? null,
      vaWithCorrection: req.body.va_with_correction ?? null,
    }, ctx(req));
    return success(res, { refraction }, 'Refraction recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record refraction');
  }
});

router.get('/patients/:uid/history', async (req, res) => {
  try {
    const history = await getPatientHistory(req.params.uid, { limit: req.query.limit });
    return success(res, history, 'Ophthalmic history');
  } catch (err) {
    return handleFailure(res, err, 'get ophthalmic history');
  }
});

export default router;
