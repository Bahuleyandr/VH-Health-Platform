// src/routes/clinical/dentalRoutes.js
//
// Roadmap D7 — dental charting. Mounted at /api/v1/dental (app.js) behind
// clinical-staff RBAC + PHI logging.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  recordToothFinding,
  resolveFinding,
  getChart,
  planProcedure,
  completeProcedure,
  cancelProcedure,
  listProcedures,
} from '../../services/clinical/dentalService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Dental ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.user?.tenantId || req?.tenant?.id || null;

router.post('/findings', async (req, res) => {
  try {
    const finding = await recordToothFinding({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      toothFdi: req.body.tooth_fdi,
      surface: req.body.surface || null,
      finding: req.body.finding,
      severity: req.body.severity || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { finding }, 'Tooth finding recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record tooth finding');
  }
});

router.post('/findings/:id/resolve', async (req, res) => {
  try {
    const finding = await resolveFinding(req.params.id, {
      resolutionNote: req.body.resolution_note,
    }, ctx(req));
    return success(res, { finding }, 'Finding resolved');
  } catch (err) {
    return handleFailure(res, err, 'resolve finding');
  }
});

router.get('/patients/:uid/chart', async (req, res) => {
  try {
    const chart = await getChart(req.params.uid);
    return success(res, { chart }, 'Dental chart');
  } catch (err) {
    return handleFailure(res, err, 'get dental chart');
  }
});

router.post('/procedures', async (req, res) => {
  try {
    const procedure = await planProcedure({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      toothFdi: req.body.tooth_fdi || null,
      surface: req.body.surface || null,
      findingId: req.body.finding_id || null,
      procedureName: req.body.procedure_name,
      procedureCode: req.body.procedure_code || null,
      anesthesia: req.body.anesthesia || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure planned', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'plan procedure');
  }
});

router.post('/procedures/:id/complete', async (req, res) => {
  try {
    const procedure = await completeProcedure(req.params.id, {
      materials: req.body.materials || null,
      anesthesia: req.body.anesthesia || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure completed');
  } catch (err) {
    return handleFailure(res, err, 'complete procedure');
  }
});

router.post('/procedures/:id/cancel', async (req, res) => {
  try {
    const procedure = await cancelProcedure(req.params.id, {
      reason: req.body.reason,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure cancelled');
  } catch (err) {
    return handleFailure(res, err, 'cancel procedure');
  }
});

router.get('/patients/:uid/procedures', async (req, res) => {
  try {
    const procedures = await listProcedures(req.params.uid, { status: req.query.status || null });
    return success(res, { procedures, count: procedures.length }, 'Dental procedures');
  } catch (err) {
    return handleFailure(res, err, 'list procedures');
  }
});

export default router;
