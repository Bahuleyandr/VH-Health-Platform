/**
 * Admin routes for MFA + API clients (Phase B4).
 *
 * Mounted at /api/v1/admin/mfa and /api/v1/admin/api-clients.
 */

import express from 'express';

import { AppError } from '../../utils/AppError.js';
import { error, success } from '../../utils/responseHelper.js';
import {
  authenticateTotp,
  consumeBackupCode,
  enrollTotpDevice,
  listMfaDevices,
  revokeDevice,
  verifyAndActivateDevice,
} from '../../services/auth/mfaService.js';
import {
  issueApiKey,
  listApiClients,
  listApiKeys,
  revokeApiKey,
  upsertApiClient,
} from '../../services/auth/apiClientService.js';

const mfaRouter = express.Router();
const apiClientsRouter = express.Router();

function isSuperAdmin(user) {
  return String(user?.role || '').toUpperCase() === 'SUPER_ADMIN';
}

function requestedMfaUserUid(req, { source = 'body', allowAllForSuperAdmin = false } = {}) {
  const actorUid = req.user?.uid || null;
  const requested = source === 'query'
    ? req.query?.user_uid || null
    : req.body?.user_uid || null;

  if (isSuperAdmin(req.user)) {
    return requested || (allowAllForSuperAdmin ? null : actorUid);
  }
  if (requested && requested !== actorUid) {
    throw AppError.forbidden('You can only manage your own MFA devices', 'MFA_USER_SCOPE_FORBIDDEN');
  }
  return actorUid;
}

// MFA
mfaRouter.post('/devices', async (req, res, next) => {
  try {
    const userUid = requestedMfaUserUid(req);
    const result = await enrollTotpDevice({
      tenantId: req.tenantId,
      userUid,
      displayName: req.body?.display_name,
      algorithm: req.body?.algorithm,
      digits: req.body?.digits,
      period: req.body?.period,
    });
    return success(res, result, 'TOTP device enrolled', 201);
  } catch (err) { return next(err); }
});

mfaRouter.post('/devices/:id/verify', async (req, res, next) => {
  try {
    if (!req.body?.code) return error(res, 'code is required', 400);
    const userUid = requestedMfaUserUid(req);
    const result = await verifyAndActivateDevice({
      tenantId: req.tenantId,
      deviceId: req.params.id,
      userUid,
      code: req.body.code,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    return success(res, result, 'Device verified');
  } catch (err) { return next(err); }
});

mfaRouter.post('/authenticate', async (req, res, next) => {
  try {
    const userUid = requestedMfaUserUid(req);
    const result = await authenticateTotp({
      tenantId: req.tenantId,
      userUid,
      code: req.body?.code,
      ipAddress: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    return success(res, result, 'TOTP authenticated');
  } catch (err) { return next(err); }
});

mfaRouter.post('/backup-codes/consume', async (req, res, next) => {
  try {
    const userUid = requestedMfaUserUid(req);
    const result = await consumeBackupCode({
      tenantId: req.tenantId,
      userUid,
      code: req.body?.code,
      ipAddress: req.ip || null,
    });
    return success(res, result, 'Backup code consumed');
  } catch (err) { return next(err); }
});

mfaRouter.patch('/devices/:id/revoke', async (req, res, next) => {
  try {
    const userUid = isSuperAdmin(req.user) ? null : req.user?.uid || null;
    const row = await revokeDevice({
      tenantId: req.tenantId,
      deviceId: req.params.id,
      userUid,
    });
    return success(res, row, 'Device revoked');
  } catch (err) { return next(err); }
});

mfaRouter.get('/devices', async (req, res, next) => {
  try {
    const userUid = requestedMfaUserUid(req, { source: 'query', allowAllForSuperAdmin: true });
    const result = await listMfaDevices({
      tenantId: req.tenantId,
      userUid,
      status: req.query.status || null,
    });
    return success(res, result, 'Devices retrieved');
  } catch (err) { return next(err); }
});

// API clients
apiClientsRouter.put('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertApiClient({
      tenantId: req.tenantId,
      id: b.id,
      clientCode: b.client_code,
      displayName: b.display_name,
      description: b.description,
      clientKind: b.client_kind,
      status: b.status,
      scopes: b.scopes,
      allowedIps: b.allowed_ips,
      rateLimitProfile: b.rate_limit_profile,
      contactEmail: b.contact_email,
      contactPhone: b.contact_phone,
      metadata: b.metadata,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'API client saved');
  } catch (err) { return next(err); }
});

apiClientsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listApiClients({
      tenantId: req.tenantId,
      status: req.query.status || null,
      clientKind: req.query.client_kind || null,
    });
    return success(res, result, 'API clients retrieved');
  } catch (err) { return next(err); }
});

apiClientsRouter.post('/:clientId/keys', async (req, res, next) => {
  try {
    const result = await issueApiKey({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      displayName: req.body?.display_name,
      expiresAt: req.body?.expires_at,
      createdBy: req.user?.uid || null,
    });
    return success(res, result, 'API key issued. Store the plaintext securely — it cannot be shown again.', 201);
  } catch (err) { return next(err); }
});

apiClientsRouter.get('/:clientId/keys', async (req, res, next) => {
  try {
    const result = await listApiKeys({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      status: req.query.status || null,
    });
    return success(res, result, 'API keys retrieved');
  } catch (err) { return next(err); }
});

apiClientsRouter.patch('/keys/:id/revoke', async (req, res, next) => {
  try {
    const row = await revokeApiKey({
      tenantId: req.tenantId,
      id: req.params.id,
      revokedReason: req.body?.revoked_reason,
    });
    return success(res, row, 'API key revoked');
  } catch (err) { return next(err); }
});

export { apiClientsRouter, mfaRouter };
export default mfaRouter;
