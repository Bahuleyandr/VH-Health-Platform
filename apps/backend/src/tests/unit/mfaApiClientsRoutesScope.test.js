import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TENANT = '00000000-0000-4000-8000-000000000001';

const enrollTotpDeviceMock = jest.fn(async () => ({ device: { id: 1 } }));
const verifyAndActivateDeviceMock = jest.fn(async () => ({ device: { id: 1 } }));
const authenticateTotpMock = jest.fn(async () => ({ authenticated: true }));
const consumeBackupCodeMock = jest.fn(async () => ({ authenticated: true }));
const revokeDeviceMock = jest.fn(async () => ({ id: 1 }));
const listMfaDevicesMock = jest.fn(async () => ({ devices: [], count: 0 }));

jest.unstable_mockModule('../../services/auth/mfaService.js', () => ({
  authenticateTotp: authenticateTotpMock,
  consumeBackupCode: consumeBackupCodeMock,
  enrollTotpDevice: enrollTotpDeviceMock,
  listMfaDevices: listMfaDevicesMock,
  revokeDevice: revokeDeviceMock,
  verifyAndActivateDevice: verifyAndActivateDeviceMock,
}));

jest.unstable_mockModule('../../services/auth/apiClientService.js', () => ({
  issueApiKey: jest.fn(),
  listApiClients: jest.fn(),
  listApiKeys: jest.fn(),
  rotateApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
  upsertApiClient: jest.fn(),
}));

const { mfaRouter } = await import('../../routes/admin/mfaApiClientsRoutes.js');

function buildApp(role = 'ADMIN') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, role };
    next();
  });
  app.use('/mfa', mfaRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('admin MFA route user scope', () => {
  it('blocks tenant admins from enrolling MFA devices for another user', async () => {
    const res = await request(buildApp('ADMIN'))
      .post('/mfa/devices')
      .send({ user_uid: OTHER, display_name: 'Other user' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_USER_SCOPE_FORBIDDEN');
    expect(enrollTotpDeviceMock).not.toHaveBeenCalled();
  });

  it('self-scopes tenant admin list and revoke operations', async () => {
    const app = buildApp('ADMIN');

    await request(app).get('/mfa/devices');
    await request(app).patch('/mfa/devices/7/revoke');

    expect(listMfaDevicesMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      userUid: ACTOR,
    }));
    expect(revokeDeviceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      deviceId: '7',
      userUid: ACTOR,
    }));
  });

  it('allows super admins to target another user or list all tenant devices', async () => {
    const app = buildApp('SUPER_ADMIN');

    await request(app).post('/mfa/devices').send({ user_uid: OTHER, display_name: 'Other user' });
    await request(app).get('/mfa/devices');

    expect(enrollTotpDeviceMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      userUid: OTHER,
    }));
    expect(listMfaDevicesMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      userUid: null,
    }));
  });
});
