import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

const upsertApiClientMock = jest.fn();
const issueApiKeyMock = jest.fn();
const rotateApiKeyMock = jest.fn();
const revokeApiKeyMock = jest.fn();

const getDeveloperPortalSummaryMock = jest.fn();
const listDeveloperPortalAuditEventsMock = jest.fn();
const recordDeveloperPortalAuditEventMock = jest.fn();
const getDeveloperPortalOpenApiDocumentMock = jest.fn();

jest.unstable_mockModule('../../services/auth/apiClientService.js', () => ({
  issueApiKey: issueApiKeyMock,
  rotateApiKey: rotateApiKeyMock,
  revokeApiKey: revokeApiKeyMock,
  upsertApiClient: upsertApiClientMock,
}));

jest.unstable_mockModule('../../services/auth/developerPortalService.js', () => ({
  getDeveloperPortalSummary: getDeveloperPortalSummaryMock,
  listDeveloperPortalAuditEvents: listDeveloperPortalAuditEventsMock,
  recordDeveloperPortalAuditEvent: recordDeveloperPortalAuditEventMock,
  getDeveloperPortalOpenApiDocument: getDeveloperPortalOpenApiDocumentMock,
}));

const { default: developerPortalRoutes } = await import('../../routes/admin/developerPortalRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role: 'ADMIN' };
    next();
  });
  app.use('/developer-portal', developerPortalRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  recordDeveloperPortalAuditEventMock.mockResolvedValue(null);
});

describe('developer portal admin routes', () => {
  it('returns the tenant-scoped portal summary', async () => {
    getDeveloperPortalSummaryMock.mockResolvedValue({
      clients: [],
      counts: {
        total_clients: 0,
        active_clients: 0,
        sandbox_clients: 0,
        production_clients: 0,
        total_keys: 0,
        active_keys: 0,
      },
      audit_events: [],
    });

    const res = await request(buildApp()).get('/developer-portal?environment=sandbox');

    expect(res.status).toBe(200);
    expect(res.body.data.clients).toEqual([]);
    expect(getDeveloperPortalSummaryMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      environment: 'sandbox',
    }));
  });

  it('saves an API client with environment metadata and records an audit event', async () => {
    upsertApiClientMock.mockResolvedValue({
      id: 7,
      client_code: 'PARTNER',
      display_name: 'Partner',
      status: 'active',
      environment: 'sandbox',
    });

    const res = await request(buildApp())
      .put('/developer-portal/api-clients')
      .send({
        client_code: 'PARTNER',
        display_name: 'Partner',
        client_kind: 'integration',
        status: 'active',
        environment: 'sandbox',
        scopes: ['system.read'],
        allowed_ips: ['203.0.113.10'],
      });

    expect(res.status).toBe(200);
    expect(upsertApiClientMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      clientCode: 'PARTNER',
      environment: 'sandbox',
      scopes: ['system.read'],
      allowedIps: ['203.0.113.10'],
      createdBy: ACTOR,
    }));
    expect(recordDeveloperPortalAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      apiClientId: 7,
      eventType: 'client.created',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      metadata: expect.objectContaining({ environment: 'sandbox' }),
    }));
  });

  it('rotates an active key and audits both old and new key identifiers', async () => {
    rotateApiKeyMock.mockResolvedValue({
      plaintext: 'vh_new_secret',
      key: { id: 10, key_prefix: 'vh_new', expires_at: null },
      revoked_key: { id: 9 },
    });

    const res = await request(buildApp())
      .post('/developer-portal/api-clients/7/keys/9/rotate')
      .send({ display_name: 'rotated', revoked_reason: 'scheduled' });

    expect(res.status).toBe(200);
    expect(res.body.data.plaintext).toBe('vh_new_secret');
    expect(rotateApiKeyMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      apiClientId: '7',
      id: '9',
      displayName: 'rotated',
      revokedReason: 'scheduled',
      createdBy: ACTOR,
    }));
    expect(recordDeveloperPortalAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      apiClientId: '7',
      apiKeyId: 10,
      eventType: 'key.rotated',
      metadata: expect.objectContaining({
        old_key_id: 9,
        new_key_prefix: 'vh_new',
      }),
    }));
  });

  it('returns the OpenAPI document and audits the download', async () => {
    getDeveloperPortalOpenApiDocumentMock.mockReturnValue({
      openapi: '3.1.0',
      paths: { '/api/v1/health': {} },
    });

    const res = await request(buildApp()).get('/developer-portal/openapi');

    expect(res.status).toBe(200);
    expect(res.body.data.document.openapi).toBe('3.1.0');
    expect(recordDeveloperPortalAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      eventType: 'openapi.downloaded',
      metadata: expect.objectContaining({ path_count: 1, spec_version: '3.1.0' }),
    }));
  });
});
