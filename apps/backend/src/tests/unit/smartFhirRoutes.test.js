import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const issueAuthorizationCodeMock = jest.fn(async () => ({
  authz: { id: 1 },
  plaintext_code: 'vh_authz_test',
}));

jest.unstable_mockModule('../../services/smartFhir/smartOAuthService.js', () => ({
  exchangeAuthorizationCode: jest.fn(),
  issueAuthorizationCode: issueAuthorizationCodeMock,
  listAccessTokens: jest.fn(),
  listSmartApps: jest.fn(),
  refreshAccessToken: jest.fn(),
  registerSmartApp: jest.fn(),
  revokeAccessToken: jest.fn(),
  verifyAccessToken: jest.fn(),
}));

const { default: smartFhirRouter } = await import('../../routes/admin/smartFhirRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = '00000000-0000-4000-8000-000000000001';
    req.user = { uid: '11111111-1111-4111-8111-111111111111' };
    next();
  });
  app.use('/smart-fhir', smartFhirRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return app;
}

describe('admin SMART authorize helper gate', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;

  beforeEach(() => {
    issueAuthorizationCodeMock.mockClear();
    delete process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;
    else process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED = originalFlag;
  });

  it('blocks the helper in production unless explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SMART_ADMIN_AUTHORIZE_DISABLED');
    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it('blocks the helper outside production unless explicitly enabled', async () => {
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SMART_ADMIN_AUTHORIZE_DISABLED');
    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it('allows the helper only when explicitly enabled', async () => {
    process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED = 'true';
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(201);
    expect(issueAuthorizationCodeMock).toHaveBeenCalled();
  });
});
