// src/routes/admin/deviceRegistryRoutes.js

import express from 'express';
import logger from '../../logging/logger.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { canManageIntegrations, isAdmin } from '../../utils/roleHelpers.js';
import {
  createDevice,
  getDeviceById,
  listDevices,
  rotateDeviceCredential,
  updateDevice,
} from '../../services/devices/deviceRegistryService.js';
import { listAssociations } from '../../services/devices/deviceAssociationService.js';
import { ingestDeviceVitals } from '../../services/emr/deviceVitalsService.js';
import prisma from '../../lib/prisma.js';

const router = express.Router();

const canManage = (role) => canManageIntegrations(role) || isAdmin(role) || role === 'SUPER_ADMIN';
const requestTenantId = (req) => req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;

function requireManage(req, res, next) {
  if (!canManage(req.user?.role)) {
    return error(res, 'Only integration admins can manage devices', HTTP_STATUS.FORBIDDEN);
  }
  return next();
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Device registry ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/', async (req, res) => {
  try {
    const devices = await listDevices({
      tenantId: requestTenantId(req),
      status: req.query.status || null,
      kind: req.query.kind || null,
      search: req.query.search || null,
      limit: req.query.limit,
    });
    return success(res, devices, 'Device registry');
  } catch (err) {
    return handleFailure(res, err, 'list devices');
  }
});

router.post('/', requireManage, async (req, res) => {
  try {
    const result = await createDevice(req.body, {
      tenantId: requestTenantId(req),
      actorUid: req.user?.uid || null,
    });
    return success(res, result, 'Device registered', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create device');
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

router.get('/messages', async (req, res) => {
  try {
    const params = [requestTenantId(req)];
    const where = ['tenant_id = $1::uuid', "message_type = 'ORU^VITALS'"];
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(Number.parseInt(req.query.limit, 10) || 100, 500));
    const messages = await prisma.$queryRawUnsafe(
      `SELECT id, analyzer_code, status, error, result_count, received_at, processed_at, verdicts
         FROM lab_interface_messages
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${params.length}::int`,
      ...params,
    );
    return success(res, { messages, count: messages.length }, 'Device interface messages');
  } catch (err) {
    return handleFailure(res, err, 'list messages');
  }
});

router.post('/messages/:id/replay', requireManage, async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, analyzer_code, raw_message
         FROM lab_interface_messages
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND message_type = 'ORU^VITALS'
        LIMIT 1`,
      requestTenantId(req),
      Number.parseInt(req.params.id, 10),
    );
    if (!rows[0]) throw AppError.notFound('Device interface message not found', 'DEVICE_MESSAGE_NOT_FOUND');
    const replay = await ingestDeviceVitals({
      tenantId: requestTenantId(req),
      deviceCode: rows[0].analyzer_code || null,
      message: rows[0].raw_message,
    }, {
      actorUid: req.user?.uid || null,
      actorRole: 'DEVICE_GATEWAY',
    });
    return success(res, { replay }, 'Device message replayed');
  } catch (err) {
    return handleFailure(res, err, 'replay message');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const device = await getDeviceById({
      tenantId: requestTenantId(req),
      id: req.params.id,
    });
    return success(res, { device }, 'Device detail');
  } catch (err) {
    return handleFailure(res, err, 'get device');
  }
});

router.patch('/:id', requireManage, async (req, res) => {
  try {
    const device = await updateDevice({
      tenantId: requestTenantId(req),
      id: req.params.id,
      patch: req.body,
    });
    return success(res, { device }, 'Device updated');
  } catch (err) {
    return handleFailure(res, err, 'update device');
  }
});

router.post('/:id/rotate-credential', requireManage, async (req, res) => {
  try {
    const result = await rotateDeviceCredential({
      tenantId: requestTenantId(req),
      id: req.params.id,
    });
    return success(res, result, 'Device credential rotated');
  } catch (err) {
    return handleFailure(res, err, 'rotate credential');
  }
});

router.post('/:id/revoke', requireManage, async (req, res) => {
  try {
    const device = await updateDevice({
      tenantId: requestTenantId(req),
      id: req.params.id,
      patch: { status: 'revoked' },
    });
    return success(res, { device }, 'Device revoked');
  } catch (err) {
    return handleFailure(res, err, 'revoke device');
  }
});

export default router;
