// N6-13 CSSD instrument tracking routes.

import { Router } from 'express';
import { CSSD_DEVICE_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
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
//
// The /api/v1/cssd mount audience is wider than the hands that run
// reprocessing — notifications_audit brings HR_STAFF,
// DATA_PROTECTION_OFFICER and COMPLIANCE_OFFICER for the audit-facing board,
// supply_chain brings PHARMACY_INCHARGE and STORES_PURCHASE_INCHARGE for
// consumption — and a device discard is irreversible. Narrow the whole
// /devices sub-tree to CSSD_DEVICE_ROUTE_ROLES (an intersection with the mount
// list, so the gate can never be dead), which is sterile processing, the
// wards, infection control, quality and platform admin. Cath-lab roles stay
// out deliberately: they hand a device to CSSD through the case post-use tap
// and take it back through the case-pinned lookup — they do not run the queue.
router.use('/devices', requireRole(...CSSD_DEVICE_ROUTE_ROLES));

// retainOnServerError is deliberately NOT set: every device action's `from`
// list (cathDeviceReuseService.js DEVICE_ACTIONS) excludes its own `to`
// state, so a retry after a post-commit 5xx finds the device already landed
// and fails the transition check with a 409 CATH_DEVICE_INVALID_TRANSITION
// naming the state it is actually in — the claim need not retain the response
// for that to be safe. A route added to this claim layer whose handler is NOT
// similarly self-blocking on retry must argue with this comment before
// leaving retainOnServerError unset.
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
