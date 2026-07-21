import express from 'express';

import { HTTP_STATUS } from '../config/responseCodes.js';
import { success, relayAppError } from '../utils/responseHelper.js';
import { getAuthenticatedActorRoles } from '../utils/roleHelpers.js';
import {
  acknowledgeColdChainExcursion,
  createColdChainUnit,
  exportTemperatureRegister,
  ingestColdChainReading,
  listColdChainDashboard,
  listColdChainUnits,
  recordColdChainCorrectiveAction,
  runSilentSensorWatchdog,
  updateColdChainUnit,
} from '../services/devices/coldChainService.js';

export const coldChainRoutes = express.Router();
export const coldChainIngestRoutes = express.Router();

const requestTenantId = (req) => req.tenantId || req.user?.tenant_id || req.user?.tenantId || req.get('x-tenant-id') || req.body?.tenant_id || null;

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || req.get('x-device-token') || req.body?.bearer_token || req.body?.sender_bearer_token || null;
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

coldChainIngestRoutes.post('/', async (req, res) => {
  try {
    const result = await ingestColdChainReading(req.body || {}, {
      tenantId: requestTenantId(req),
      bearerToken: extractBearer(req),
      sourceIp: req.ip || req.socket?.remoteAddress || null,
    });
    const status = result.action === 'excursion_opened' ? HTTP_STATUS.CREATED : HTTP_STATUS.OK;
    return success(res, result, 'Cold-chain reading ingested', status);
  } catch (err) {
    return handleFailure(res, err, 'ingest cold-chain reading');
  }
});

coldChainRoutes.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await listColdChainDashboard({ tenantId: requestTenantId(req) });
    return success(res, dashboard, 'Cold-chain dashboard retrieved');
  } catch (err) {
    return handleFailure(res, err, 'load cold-chain dashboard');
  }
});

coldChainRoutes.get('/units', async (req, res) => {
  try {
    const result = await listColdChainUnits({
      tenantId: requestTenantId(req),
      status: req.query.status || null,
      department: req.query.department || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Cold-chain units retrieved');
  } catch (err) {
    return handleFailure(res, err, 'list cold-chain units');
  }
});

coldChainRoutes.post('/units', async (req, res) => {
  try {
    const unit = await createColdChainUnit(req.body || {}, {
      tenantId: requestTenantId(req),
      actorUid: req.user?.uid || null,
    });
    return success(res, { unit }, 'Cold-chain unit created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create cold-chain unit');
  }
});

coldChainRoutes.patch('/units/:id', async (req, res) => {
  try {
    const unit = await updateColdChainUnit({
      tenantId: requestTenantId(req),
      id: req.params.id,
      patch: req.body || {},
    });
    return success(res, { unit }, 'Cold-chain unit updated');
  } catch (err) {
    return handleFailure(res, err, 'update cold-chain unit');
  }
});

coldChainRoutes.post('/ingest', async (req, res) => {
  try {
    const result = await ingestColdChainReading(req.body || {}, {
      tenantId: requestTenantId(req),
      bearerToken: extractBearer(req),
      sourceIp: req.ip || req.socket?.remoteAddress || null,
      actorUid: req.user?.uid || null,
    });
    const status = result.action === 'excursion_opened' ? HTTP_STATUS.CREATED : HTTP_STATUS.OK;
    return success(res, result, 'Cold-chain reading ingested', status);
  } catch (err) {
    return handleFailure(res, err, 'ingest cold-chain reading');
  }
});

coldChainRoutes.post('/excursions/:id/acknowledge', async (req, res) => {
  try {
    const excursion = await acknowledgeColdChainExcursion({
      tenantId: requestTenantId(req),
      id: req.params.id,
      actorUid: req.user?.uid || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
    });
    return success(res, { excursion }, 'Cold-chain excursion acknowledged');
  } catch (err) {
    return handleFailure(res, err, 'acknowledge cold-chain excursion');
  }
});

coldChainRoutes.post('/excursions/:id/corrective-action', async (req, res) => {
  try {
    const excursion = await recordColdChainCorrectiveAction({
      tenantId: requestTenantId(req),
      id: req.params.id,
      correctiveAction: req.body?.corrective_action ?? req.body?.correctiveAction,
      dispositionNote: req.body?.disposition_note ?? req.body?.dispositionNote,
      actorUid: req.user?.uid || null,
      actorRoles: getAuthenticatedActorRoles(req.user),
    });
    return success(res, { excursion }, 'Cold-chain corrective action recorded');
  } catch (err) {
    return handleFailure(res, err, 'record cold-chain corrective action');
  }
});

coldChainRoutes.post('/watchdog/run', async (req, res) => {
  try {
    const result = await runSilentSensorWatchdog({ tenantId: requestTenantId(req) });
    return success(res, result, 'Cold-chain silent-sensor watchdog completed');
  } catch (err) {
    return handleFailure(res, err, 'run cold-chain watchdog');
  }
});

coldChainRoutes.get('/units/:id/register', async (req, res) => {
  try {
    const exported = await exportTemperatureRegister({
      tenantId: requestTenantId(req),
      unitId: req.params.id,
      month: req.query.month,
      format: req.query.format || 'csv',
    });
    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return res.send(exported.body);
  } catch (err) {
    return handleFailure(res, err, 'export cold-chain register');
  }
});

export default coldChainRoutes;
