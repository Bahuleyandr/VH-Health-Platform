// src/routes/clinical/physioRoutes.js
//
// NL6-11 — physiotherapy and rehabilitation endpoints. Mounted behind
// physiotherapy/clinical RBAC, patient guard, string sanitizer, and PHI logger.

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, relayAppError } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import {
  createAssessment,
  createTherapyPlan,
  getAdminProgress,
  getOutcomeTrend,
  getPatientSummary,
  listWorklist,
  recordOutcomeScore,
  recordSession,
} from '../../services/clinical/physioService.js';

const router = express.Router();

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => resolveTenantOrThrow(req);

router.get('/worklist', async (req, res) => {
  try {
    const worklist = await listWorklist({
      tenantId: tenantOf(req),
      limit: req.query.limit,
    });
    return success(res, { worklist: worklist.items, count: worklist.count }, 'Physio worklist');
  } catch (err) {
    return handleFailure(res, err, 'load physio worklist');
  }
});

router.post('/assessments', async (req, res) => {
  try {
    const assessment = await createAssessment({
      ...req.body,
      tenantId: tenantOf(req),
    }, ctx(req));
    return success(res, { assessment }, 'Physio assessment recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record physio assessment');
  }
});

router.post('/therapy-plans', async (req, res) => {
  try {
    const carePlan = await createTherapyPlan({
      ...req.body,
      tenantId: tenantOf(req),
    }, ctx(req));
    return success(res, { care_plan: carePlan }, 'Physio therapy plan started', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'start physio therapy plan');
  }
});

router.post('/sessions', async (req, res) => {
  try {
    const result = await recordSession({
      ...req.body,
      tenantId: tenantOf(req),
    }, ctx(req));
    return success(res, result, 'Physio session recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record physio session');
  }
});

router.post('/outcomes', async (req, res) => {
  try {
    const outcome = await recordOutcomeScore({
      ...req.body,
      tenantId: tenantOf(req),
    }, ctx(req));
    return success(res, { outcome }, 'Physio outcome score recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record physio outcome score');
  }
});

router.get('/care-plans/:id/outcomes', async (req, res) => {
  try {
    const trend = await getOutcomeTrend({
      tenantId: tenantOf(req),
      carePlanId: req.params.id,
      patientUid: req.query.patient_uid,
      scoreKind: req.query.score_kind || 'functional',
      limit: req.query.limit,
    });
    return success(res, { trend }, 'Physio outcome trend');
  } catch (err) {
    return handleFailure(res, err, 'load physio outcome trend');
  }
});

router.get('/patients/:uid/summary', async (req, res) => {
  try {
    const summary = await getPatientSummary({
      tenantId: tenantOf(req),
      patientUid: req.params.uid,
    });
    return success(res, { summary }, 'Physio patient summary');
  } catch (err) {
    return handleFailure(res, err, 'load physio patient summary');
  }
});

router.get('/admin/progress', async (req, res) => {
  try {
    const progress = await getAdminProgress({
      tenantId: tenantOf(req),
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, progress, 'Physio admin progress');
  } catch (err) {
    return handleFailure(res, err, 'load physio admin progress');
  }
});

export default router;
