import express from 'express';

import {
  issueApiKey,
  rotateApiKey,
  revokeApiKey,
  upsertApiClient,
} from '../../services/auth/apiClientService.js';
import {
  getDeveloperPortalOpenApiDocument,
  getDeveloperPortalSummary,
  listDeveloperPortalAuditEvents,
  recordDeveloperPortalAuditEvent,
} from '../../services/auth/developerPortalService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function auditContext(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const result = await getDeveloperPortalSummary({
      tenantId: req.tenantId,
      status: req.query.status || null,
      clientKind: req.query.client_kind || null,
      environment: req.query.environment || null,
    });
    return success(res, result, 'Developer portal retrieved');
  } catch (err) { return next(err); }
});

router.put('/api-clients', async (req, res, next) => {
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
    await recordDeveloperPortalAuditEvent({
      tenantId: req.tenantId,
      apiClientId: row.id,
      eventType: b.id ? 'client.updated' : 'client.created',
      summary: b.id ? 'API client updated from developer portal' : 'API client created from developer portal',
      metadata: {
        client_code: row.client_code,
        status: row.status,
        environment: row.environment,
      },
      ...auditContext(req),
    });
    return success(res, row, 'Developer portal API client saved');
  } catch (err) { return next(err); }
});

router.post('/api-clients/:clientId/keys', async (req, res, next) => {
  try {
    const result = await issueApiKey({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      displayName: req.body?.display_name,
      expiresAt: req.body?.expires_at,
      createdBy: req.user?.uid || null,
    });
    await recordDeveloperPortalAuditEvent({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      apiKeyId: result.key?.id,
      eventType: 'key.issued',
      summary: 'API key issued from developer portal',
      metadata: {
        key_prefix: result.key?.key_prefix,
        expires_at: result.key?.expires_at || null,
      },
      ...auditContext(req),
    });
    return success(res, result, 'API key issued. Store the plaintext securely; it cannot be shown again.', 201);
  } catch (err) { return next(err); }
});

router.post('/api-clients/:clientId/keys/:keyId/rotate', async (req, res, next) => {
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
    await recordDeveloperPortalAuditEvent({
      tenantId: req.tenantId,
      apiClientId: req.params.clientId,
      apiKeyId: result.key?.id,
      eventType: 'key.rotated',
      summary: 'API key rotated from developer portal',
      metadata: {
        old_key_id: result.revoked_key?.id,
        new_key_prefix: result.key?.key_prefix,
        expires_at: result.key?.expires_at || null,
      },
      ...auditContext(req),
    });
    return success(res, result, 'API key rotated. Store the new plaintext securely; it cannot be shown again.');
  } catch (err) { return next(err); }
});

router.patch('/api-keys/:id/revoke', async (req, res, next) => {
  try {
    const row = await revokeApiKey({
      tenantId: req.tenantId,
      id: req.params.id,
      revokedReason: req.body?.revoked_reason,
    });
    await recordDeveloperPortalAuditEvent({
      tenantId: req.tenantId,
      apiClientId: row.api_client_id,
      apiKeyId: row.id,
      eventType: 'key.revoked',
      summary: 'API key revoked from developer portal',
      metadata: {
        key_prefix: row.key_prefix,
        revoked_reason: row.revoked_reason || null,
      },
      ...auditContext(req),
    });
    return success(res, row, 'API key revoked');
  } catch (err) { return next(err); }
});

router.get('/audit-events', async (req, res, next) => {
  try {
    const result = await listDeveloperPortalAuditEvents({
      tenantId: req.tenantId,
      apiClientId: req.query.api_client_id || null,
      eventType: req.query.event_type || null,
      limit: req.query.limit || 50,
    });
    return success(res, result, 'Developer portal audit events retrieved');
  } catch (err) { return next(err); }
});

router.get('/openapi', async (req, res, next) => {
  try {
    const document = getDeveloperPortalOpenApiDocument();
    await recordDeveloperPortalAuditEvent({
      tenantId: req.tenantId,
      eventType: 'openapi.downloaded',
      summary: 'OpenAPI document downloaded from developer portal',
      metadata: {
        path_count: Object.keys(document.paths || {}).length,
        spec_version: document.openapi || null,
      },
      ...auditContext(req),
    });
    return success(res, { document }, 'OpenAPI document retrieved');
  } catch (err) { return next(err); }
});

export default router;
