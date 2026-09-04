// N6-13 CSSD instrument tracking routes.

import { Router } from 'express';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  discardDevice,
  listDevices,
  markDeviceReprocessed,
  quarantineDevice,
  receiveDevice,
  releaseDevice,
} from '../../services/clinical/cathDeviceReuseService.js';
import * as cssd from '../../services/cssd/cssdService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, relayAppError } from '../../utils/responseHelper.js';

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
      return relayAppError(res, err, 'CSSD request failed');
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

// Reprocessable cath devices (spec 2026-09-04 §6.4). No patient data on this
// router: the register carries none (patient linkage lives on the cath usage
// rows), so CSSD roles read and transition devices without a PHI surface.
const deviceIdempotency = requireIdempotencyKey({ required: true, scope: 'cssd_device_transition' });
const deviceContext = (req) => ({
  ...contextOf(req),
  idempotencyKey: req.idempotencyClaim?.requestKey || null,
});

router.get('/devices', wrap((req) =>
  listDevices({
    tenantId: contextOf(req).tenantId,
    status: req.query.status,
    facilityId: req.query.facility_id,
    limit: req.query.limit,
  })));

router.post('/devices/:id/receive', deviceIdempotency, wrap((req) =>
  receiveDevice(req.params.id, deviceContext(req)), { message: 'Device received in CSSD' }));

router.post('/devices/:id/reprocessed', deviceIdempotency, wrap((req) =>
  markDeviceReprocessed(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device reprocessed' }));

router.post('/devices/:id/quarantine', deviceIdempotency, wrap((req) =>
  quarantineDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device quarantined' }));

router.post('/devices/:id/release', deviceIdempotency, wrap((req) =>
  releaseDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device released for reprocessing' }));

router.post('/devices/:id/discard', deviceIdempotency, wrap((req) =>
  discardDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device discarded' }));

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
