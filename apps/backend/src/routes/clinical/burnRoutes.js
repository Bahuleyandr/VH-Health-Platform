import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as burns from '../../services/clinical/burnCareService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function actorFrom(req) {
  return {
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  };
}

function wrap(handler, { status = 200, message = 'Success' } = {}) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      return success(res, data, message, status);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode, err.details);
      logger.error('burn route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

router.get('/charts', wrap(async (req) =>
  burns.listBurnCharts({
    tenantId: tenantOf(req),
    patientUid: req.query.patient_uid || req.query.patientUid,
    emergencyVisitId: req.query.emergency_visit_id || req.query.emergencyVisitId,
    admissionId: req.query.admission_id || req.query.admissionId,
    mlcRecordId: req.query.mlc_record_id || req.query.mlcRecordId,
    limit: req.query.limit,
  })));

router.post('/charts', wrap(async (req) =>
  burns.createBurnChart({
    tenantId: tenantOf(req),
    ...req.body,
    ...actorFrom(req),
  }), { status: 201, message: 'Burn chart created' }));

router.get('/charts/:id', wrap(async (req) =>
  burns.getBurnChart({
    tenantId: tenantOf(req),
    id: req.params.id,
  })));

router.post('/charts/:id/tbsa-regions', wrap(async (req) =>
  burns.recordTbsaRegions({
    tenantId: tenantOf(req),
    burnChartId: req.params.id,
    ...req.body,
    ...actorFrom(req),
  }), { status: 201, message: 'Burn TBSA regions recorded' }));

router.post('/charts/:id/reassessments', wrap(async (req) =>
  burns.recordReassessment({
    tenantId: tenantOf(req),
    burnChartId: req.params.id,
    ...req.body,
    ...actorFrom(req),
  }), { status: 201, message: 'Burn reassessment recorded' }));

router.post('/charts/:id/fluid-worksheets', wrap(async (req) =>
  burns.recordFluidWorksheet({
    tenantId: tenantOf(req),
    burnChartId: req.params.id,
    ...req.body,
    ...actorFrom(req),
  }), { status: 201, message: 'Burn fluid worksheet recorded' }));

router.get('/charts/:id/protocol-links', wrap(async (req) =>
  burns.listProtocolContentLinks({
    tenantId: tenantOf(req),
    burnChartId: req.params.id,
  })));

router.post('/charts/:id/protocol-links', wrap(async (req) =>
  burns.linkProtocolContent({
    tenantId: tenantOf(req),
    burnChartId: req.params.id,
    ...req.body,
    ...actorFrom(req),
  }), { status: 201, message: 'Burn protocol content linked' }));

export default router;
