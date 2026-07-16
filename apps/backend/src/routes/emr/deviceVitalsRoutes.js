// src/routes/emr/deviceVitalsRoutes.js
//
// Roadmap C5 — ICU monitor vitals. Mounted at /api/v1/devices (app.js).
//   POST /vitals/ingest        — monitor/gateway pushes ORU^R01
//   GET  /vitals/unverified    — ICU review queue
//   POST /vitals/:id/verify    — clinician verification (audited)

import express from 'express';
import {
  ingestDeviceVitals,
  listUnverifiedDeviceVitals,
  resolveDeviceForGateway,
  verifyDeviceVitals,
} from '../../services/emr/deviceVitalsService.js';
import {
  listDevices,
} from '../../services/devices/deviceRegistryService.js';
import {
  associateDevicePatient,
  disconnectAssociation,
  listAssociations,
} from '../../services/devices/deviceAssociationService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isClinical, isAdmin, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canVerify = (role) => isClinical(role) || isDoctor(role) || isAdmin(role) || role === 'SUPER_ADMIN';
const isGateway = (role) => role === 'DEVICE_GATEWAY';
const requestTenantId = (req) => req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;

function gatewaySurfaceGuard(req, res, next) {
  if (!isGateway(req.user?.role)) return next();
  const allowed = req.method === 'POST' && (req.path === '/vitals/ingest' || req.path === '/vitals/resolve');
  if (!allowed) {
    return error(res, 'DEVICE_GATEWAY can only access device ingest endpoints', HTTP_STATUS.FORBIDDEN);
  }
  return next();
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.use(gatewaySurfaceGuard);

router.post('/vitals/ingest', async (req, res) => {
  try {
    if (!isGateway(req.user?.role) && req.body.patient_uid) {
      return error(res, 'patient_uid is only accepted from DEVICE_GATEWAY callers', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await ingestDeviceVitals({
      message: req.body.message,
      deviceCode: req.body.device_code || null,
      patientUid: req.body.patient_uid || null,
      channel: req.body.channel || null,
      tenantId: requestTenantId(req), // CAN-045: scope to the caller's tenant (no default)
    }, { actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
    const status = result?.duplicate || result?.suppressed ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
    return success(res, result, 'Device vitals ingested (unverified)', status);
  } catch (err) {
    return handleFailure(res, err, 'ingest device vitals');
  }
});

router.post('/vitals/resolve', async (req, res) => {
  try {
    const token = req.body.sender_bearer_token || req.body.bearer_token || req.get('x-device-token') || null;
    const result = await resolveDeviceForGateway({
      tenantId: requestTenantId(req),
      sourceIp: req.body.source_ip || req.ip || null,
      bearerToken: token,
      deviceCode: req.body.device_code || null,
      channel: req.body.channel || '',
    });
    return success(res, result, 'Device sender resolved');
  } catch (err) {
    return handleFailure(res, err, 'resolve device sender');
  }
});

router.get('/vitals/unverified', async (req, res) => {
  try {
    const rows = await listUnverifiedDeviceVitals({
      patientUid: req.query.patient_uid || null,
      limit: req.query.limit,
      tenantId: requestTenantId(req), // CAN-045
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
      actorUid: req.user?.uid || null, actorRole: req.user?.role || null, tenantId: requestTenantId(req), // CAN-045
    });
    return success(res, { vitals: row }, 'Device vitals verified');
  } catch (err) {
    return handleFailure(res, err, 'verify device vitals');
  }
});

router.get('/registry', async (req, res) => {
  try {
    const devices = await listDevices({
      tenantId: requestTenantId(req),
      status: req.query.status || 'active',
      kind: req.query.kind || null,
      search: req.query.search || null,
      limit: req.query.limit,
    });
    return success(res, devices, 'Device registry');
  } catch (err) {
    return handleFailure(res, err, 'list devices');
  }
});

router.get('/associations', async (req, res) => {
  try {
    const associations = await listAssociations({
      tenantId: requestTenantId(req),
      activeOnly: req.query.active !== 'false',
      patientUid: req.query.patient_uid || null,
      deviceId: req.query.device_id || null,
      limit: req.query.limit,
    });
    return success(res, associations, 'Device associations');
  } catch (err) {
    return handleFailure(res, err, 'list associations');
  }
});

router.post('/associations', async (req, res) => {
  try {
    const association = await associateDevicePatient({
      device_id: req.body.device_id,
      device_code: req.body.device_code,
      patient_uid: req.body.patient_uid,
      bed_id: req.body.bed_id,
      channel: req.body.channel || '',
      start_method: req.body.start_method || 'manual',
      metadata: req.body.metadata || {},
    }, {
      tenantId: requestTenantId(req),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, { association }, 'Device associated', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'associate device');
  }
});

router.post('/associations/:id/disconnect', async (req, res) => {
  try {
    const association = await disconnectAssociation({
      id: req.params.id,
      end_reason: req.body.end_reason || 'manual',
    }, {
      tenantId: requestTenantId(req),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, { association }, 'Device association disconnected');
  } catch (err) {
    return handleFailure(res, err, 'disconnect device association');
  }
});

export default router;
