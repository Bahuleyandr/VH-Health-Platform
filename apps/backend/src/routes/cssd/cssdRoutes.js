// N6-13 CSSD instrument tracking routes.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as cssd from '../../services/cssd/cssdService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

function contextOf(req) {
  return {
    tenantId: resolveTenantOrThrow(req),
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
  };
}

function wrap(handler, { status = 200, message = 'Success' } = {}) {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return undefined;
      return success(res, data, message, status);
    } catch (err) {
      if (err.statusCode) {
        const details = err.details && typeof err.details === 'object'
          ? { ...err.details, topLevel: { code: err.code } }
          : { topLevel: { code: err.code } };
        return error(res, err.message, err.statusCode, details);
      }
      logger.error('CSSD route error', { err });
      return error(res, 'CSSD request failed', 500);
    }
  };
}

router.get('/board', wrap((req) =>
  cssd.getCssdBoard({
    tenantId: contextOf(req).tenantId,
    limit: req.query.limit,
  })));

router.get('/sets', wrap((req) =>
  cssd.listInstrumentSets({
    tenantId: contextOf(req).tenantId,
    status: req.query.status,
    usable: req.query.usable,
    q: req.query.q,
    limit: req.query.limit,
  })));

router.post('/sets', wrap((req) =>
  cssd.createInstrumentSet(req.body, contextOf(req)), {
  status: 201,
  message: 'Instrument set created',
}));

router.get('/sets/:id/label', wrap((req) =>
  cssd.getInstrumentSetLabel(req.params.id, contextOf(req))));

router.get('/loads', wrap((req) =>
  cssd.listSterilizationLoads({
    tenantId: contextOf(req).tenantId,
    status: req.query.status,
    limit: req.query.limit,
  })));

router.post('/loads', wrap((req) =>
  cssd.createSterilizationLoad(req.body, contextOf(req)), {
  status: 201,
  message: 'Sterilization load created',
}));

router.patch('/loads/:id/status', wrap((req) =>
  cssd.transitionSterilizationLoad(req.params.id, req.body, contextOf(req))));

router.get('/issues', wrap((req) =>
  cssd.listIssues({
    tenantId: contextOf(req).tenantId,
    ot_schedule_id: req.query.ot_schedule_id,
    status: req.query.status,
    limit: req.query.limit,
  })));

router.post('/issues', wrap((req) =>
  cssd.issueSet(req.body, contextOf(req)), {
  status: 201,
  message: 'Instrument set issued',
}));

router.post('/issues/:id/theatre-use', wrap((req) =>
  cssd.markTheatreUse(req.params.id, req.body, contextOf(req))));

router.post('/issues/:id/return', wrap((req) =>
  cssd.returnIssuedSet(req.params.id, req.body, contextOf(req))));

router.post('/issues/:id/decontaminate', wrap((req) =>
  cssd.markDecontaminated(req.params.id, req.body, contextOf(req))));

router.post('/issues/:id/cancel', wrap((req) =>
  cssd.cancelIssue(req.params.id, req.body, contextOf(req))));

router.get('/theatre/:otScheduleId/warnings', wrap((req) =>
  cssd.getOtSterilityWarnings({
    tenantId: contextOf(req).tenantId,
    otScheduleId: req.params.otScheduleId,
  })));

export default router;
