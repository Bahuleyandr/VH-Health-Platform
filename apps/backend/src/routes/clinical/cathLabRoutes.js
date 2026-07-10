import { Router } from 'express';
import logger from '../../logging/logger.js';
import {
  addContrastRadiationRecord,
  addDeviceLink,
  addHemodynamicSummary,
  addPostProcedureOrder,
  createCase,
  getCase,
  listCases,
  recordProcedureLog,
  transitionCaseStatus,
  updateReadinessCheck
} from '../../services/clinical/cathLabService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function contextOf(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null
  };
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Cath-lab ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/cases', async (req, res) => {
  try {
    const cases = await listCases({
      tenantId: tenantOf(req),
      date: req.query.date || null,
      status: req.query.status || null,
      limit: req.query.limit || 100
    });
    return success(res, { cases, count: cases.length }, 'Cath-lab cases');
  } catch (err) {
    return handleFailure(res, err, 'list cases');
  }
});

router.post('/cases', async (req, res) => {
  try {
    const cathCase = await createCase({ tenantId: tenantOf(req), ...req.body }, contextOf(req));
    return success(res, { case: cathCase }, 'Cath-lab case created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create case');
  }
});

router.get('/cases/:id', async (req, res) => {
  try {
    const cathCase = await getCase(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { case: cathCase }, 'Cath-lab case');
  } catch (err) {
    return handleFailure(res, err, 'get case');
  }
});

router.post('/cases/:id/status', async (req, res) => {
  try {
    const cathCase = await transitionCaseStatus(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, { case: cathCase }, 'Cath-lab case status updated');
  } catch (err) {
    return handleFailure(res, err, 'update case status');
  }
});

router.post('/cases/:id/readiness', async (req, res) => {
  try {
    const readiness = await updateReadinessCheck(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, readiness, 'Cath-lab readiness updated');
  } catch (err) {
    return handleFailure(res, err, 'update readiness');
  }
});

router.post('/cases/:id/procedure-logs', async (req, res) => {
  try {
    const procedure = await recordProcedureLog(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, { procedure }, 'Cath procedure logged', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record procedure log');
  }
});

router.post('/cases/:id/hemodynamics', async (req, res) => {
  try {
    const summary = await addHemodynamicSummary(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, { summary }, 'Cath hemodynamic summary recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record hemodynamic summary');
  }
});

router.post('/cases/:id/contrast-radiation', async (req, res) => {
  try {
    const record = await addContrastRadiationRecord(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(
      res,
      { record },
      'Cath contrast and radiation record saved',
      HTTP_STATUS.CREATED
    );
  } catch (err) {
    return handleFailure(res, err, 'record contrast and radiation summary');
  }
});

router.post('/cases/:id/post-orders', async (req, res) => {
  try {
    const order = await addPostProcedureOrder(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, { order }, 'Cath post-procedure orders saved', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record post-procedure orders');
  }
});

router.post('/cases/:id/device-links', async (req, res) => {
  try {
    const link = await addDeviceLink(
      req.params.id,
      { tenantId: tenantOf(req), ...req.body },
      contextOf(req)
    );
    return success(res, { link }, 'Cath device link attached', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'attach device link');
  }
});

export default router;
