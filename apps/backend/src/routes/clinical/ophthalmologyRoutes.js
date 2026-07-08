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
  recordBiometry,
  attachImaging,
  generateSpectaclesPrescriptionPdf,
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
      encounterId: req.body.encounter_id || null,
      appointmentId: req.body.appointment_id ?? null,
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

router.post('/exams/:id/biometry', async (req, res) => {
  try {
    const biometry = await recordBiometry(req.params.id, {
      tenantId: tenantOf(req),
      eye: req.body.eye,
      k1Diopters: req.body.k1_diopters ?? null,
      k1Axis: req.body.k1_axis ?? null,
      k2Diopters: req.body.k2_diopters ?? null,
      k2Axis: req.body.k2_axis ?? null,
      axialLengthMm: req.body.axial_length_mm,
      anteriorChamberDepthMm: req.body.anterior_chamber_depth_mm ?? null,
      lensThicknessMm: req.body.lens_thickness_mm ?? null,
      whiteToWhiteMm: req.body.white_to_white_mm ?? null,
      targetRefraction: req.body.target_refraction ?? null,
      iolFormula: req.body.iol_formula || null,
      selectedIolPower: req.body.selected_iol_power ?? null,
      selectedIolModel: req.body.selected_iol_model || null,
      calculationReference: req.body.calculation_reference || null,
      notes: req.body.notes || null,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { biometry }, 'Biometry recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record biometry');
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

router.post('/exams/:id/imaging-attachments', async (req, res) => {
  try {
    const attachment = await attachImaging(req.params.id, {
      tenantId: tenantOf(req),
      eye: req.body.eye ?? null,
      imageType: req.body.image_type || 'other',
      storageKey: req.body.storage_key,
      storageUrl: req.body.storage_url || null,
      mimeType: req.body.mime_type,
      fileSize: req.body.file_size ?? null,
      sha256Hash: req.body.sha256_hash || null,
      capturedAt: req.body.captured_at || null,
      metadata: req.body.metadata || {},
    }, ctx(req));
    return success(res, { attachment }, 'Imaging attachment linked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'link imaging attachment');
  }
});

router.get('/exams/:id/spectacles-rx.pdf', async (req, res) => {
  try {
    const pdf = await generateSpectaclesPrescriptionPdf(req.params.id, { tenantId: tenantOf(req) });
    res.setHeader('Content-Type', pdf.content_type);
    res.setHeader('Content-Disposition', `inline; filename="${pdf.filename}"`);
    return res.status(HTTP_STATUS.OK).send(pdf.buffer);
  } catch (err) {
    return handleFailure(res, err, 'generate spectacles prescription');
  }
});

router.get('/patients/:uid/history', async (req, res) => {
  try {
    const history = await getPatientHistory(req.params.uid, {
      tenantId: tenantOf(req),
      limit: req.query.limit,
    });
    return success(res, history, 'Ophthalmic history');
  } catch (err) {
    return handleFailure(res, err, 'get ophthalmic history');
  }
});

export default router;
