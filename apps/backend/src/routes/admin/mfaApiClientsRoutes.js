/**
 * Admin routes for API clients (Phase B4).
 *
 * Mounted at /api/v1/admin/api-clients.
 *
 * The Phase-B4 /api/v1/admin/mfa half of this file was deleted (re-audit
 * 2026-08-23) — it was a second, parallel TOTP stack (services/auth/mfaService.js
 * over the migration-120 mfa_* tables) with no caller in any client. The live
 * admin MFA path is routes/auth/adminAuthRoutes.js → controllers/auth/
 * adminAuthController (/api/v1/auth/admin/mfa/*), which stores TOTP state on
 * the admin row via utils/totpUtils.js. Do not reintroduce a second stack.
 *
 * The filename still drives the `mfa-api-clients` OpenAPI tag (tag inference
 * falls back to the route module's filename) — renaming it retags all six
 * operations and needs a matching OPENAPI_TAG_REGISTRY change.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  issueApiKey,
  listApiClients,
  listApiKeys,
  rotateApiKey,
  revokeApiKey,
  upsertApiClient,
} from '../../services/auth/apiClientService.js';

const apiClientsRouter = express.Router();

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
      environment: b.environment,
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
      environment: req.query.environment || null,
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

apiClientsRouter.post('/:clientId/keys/:keyId/rotate', async (req, res, next) => {
  try {
    const result = await rotateApiKey({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      id: req.params.keyId,
      displayName: req.body?.display_name,
      expiresAt: req.body?.expires_at,
      revokedReason: req.body?.revoked_reason || 'rotated',
      createdBy: req.user?.uid || null,
    });
    return success(res, result, 'API key rotated. Store the new plaintext securely — it cannot be shown again.');
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

export { apiClientsRouter };
export default apiClientsRouter;
