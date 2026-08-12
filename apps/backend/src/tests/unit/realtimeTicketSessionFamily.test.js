import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const generateTokenMock = jest.fn(() => 'signed-ws-ticket');
const verifyTokenMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: generateTokenMock,
  verifyToken: verifyTokenMock,
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isUserTokensRevoked: jest.fn().mockResolvedValue(false),
  RevocationCheckUnavailableError: class extends Error {},
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: realtimeTicketRoutes } = await import('../../routes/realtime/realtimeTicketRoutes.js');
const { default: jwtMiddleware } = await import('../../middleware/jwtMiddleware.js');

const GUARDIAN_UID = 'b0000000-0000-4000-8000-000000000001';
const DEPENDENT_UID = 'c0000000-0000-4000-8000-000000000002';
const TENANT_ID = 'd0000000-0000-4000-8000-000000000003';

function dependentRow(overrides = {}) {
  return {
    dep_id: 20,
    dep_uid: DEPENDENT_UID,
    dep_phone: '+919111111111',
    dep_email: 'dependent@test.local',
    dep_role: 'PATIENT',
    dep_is_minor: true,
    dep_tenant_id: TENANT_ID,
    dep_is_active: true,
    dep_status: 'active',
    dep_is_deleted: false,
    dep_deleted_at: null,
    dep_merged_into_uid: null,
    g_id: 10,
    g_uid: GUARDIAN_UID,
    g_role: 'PATIENT',
    g_tenant_id: TENANT_ID,
    g_is_active: true,
    g_status: 'active',
    g_is_deleted: false,
    g_deleted_at: null,
    g_merged_into_uid: null,
    ...overrides,
  };
}

let currentActing = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = 'tenant-1';
  req.user = {
    uid: 'user-1',
    role: 'PATIENT',
    jti: 'access-jti-after-refresh',
    sessionFamilyId: 'session-family-1',
    stableDeviceId: 'device-1',
  };
  req.acting = currentActing;
  next();
});
app.use('/api/v1/realtime', realtimeTicketRoutes);

const delegatedApp = express();
delegatedApp.use(express.json());
delegatedApp.use(jwtMiddleware);
delegatedApp.use('/api/v1/realtime', realtimeTicketRoutes);

describe('POST /api/v1/realtime/ticket session binding', () => {
  beforeEach(() => {
    generateTokenMock.mockClear();
    verifyTokenMock.mockReset();
    verifyTokenMock.mockReturnValue({
      uid: GUARDIAN_UID,
      id: 10,
      role: 'PATIENT',
      scope: 'full',
      tenant_id: TENANT_ID,
      jti: 'guardian-access-jti',
      sessionFamilyId: 'guardian-session-family',
      stableDeviceId: 'guardian-device',
    });
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([dependentRow()]);
    currentActing = null;
  });

  it('binds the short-lived ticket to the parent access-token session', async () => {
    const response = await request(app).post('/api/v1/realtime/ticket');

    expect(response.status).toBe(200);
    expect(generateTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'ws',
        sessionFamilyId: 'session-family-1',
        stableDeviceId: 'device-1',
      }),
      '60s',
    );
    expect(generateTokenMock.mock.calls[0][0]).not.toHaveProperty('revocationOwnerUid');
  });

  it('binds a delegated ticket to its authenticated guardian for revocation', async () => {
    currentActing = { actorUid: 'guardian-1' };

    const response = await request(app).post('/api/v1/realtime/ticket');

    expect(response.status).toBe(200);
    expect(generateTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'user-1',
        revocationOwnerUid: 'guardian-1',
        sessionFamilyId: 'session-family-1',
        stableDeviceId: 'device-1',
      }),
      '60s',
    );
  });
});

describe('POST /api/v1/realtime/ticket delegated-subject lifecycle', () => {
  beforeEach(() => {
    generateTokenMock.mockClear();
    verifyTokenMock.mockReset();
    verifyTokenMock.mockReturnValue({
      uid: GUARDIAN_UID,
      id: 10,
      role: 'PATIENT',
      scope: 'full',
      tenant_id: TENANT_ID,
      jti: 'guardian-access-jti',
      sessionFamilyId: 'guardian-session-family',
      stableDeviceId: 'guardian-device',
    });
    queryRawUnsafeMock.mockReset();
  });

  async function mintFor(row) {
    queryRawUnsafeMock.mockResolvedValueOnce([row]);
    return request(delegatedApp)
      .post('/api/v1/realtime/ticket')
      .set('Authorization', 'Bearer guardian-access-token')
      .set('X-Acting-As-Uid', DEPENDENT_UID);
  }

  it.each([
    ['inactive', { dep_is_active: false }],
    ['deleted', { dep_is_deleted: true, dep_deleted_at: new Date().toISOString(), dep_status: 'deleted' }],
    ['merged', { dep_merged_into_uid: 'e0000000-0000-4000-8000-000000000004' }],
  ])('does not mint a delegated ticket for an %s dependent', async (_label, lifecycle) => {
    const response = await mintFor(dependentRow(lifecycle));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
    expect(generateTokenMock).not.toHaveBeenCalled();
  });

  it.each([
    ['inactive', { g_is_active: false }],
    ['non-active status', { g_status: 'suspended' }],
    ['deleted', { g_is_deleted: true, g_deleted_at: new Date().toISOString(), g_status: 'deleted' }],
    ['merged', { g_merged_into_uid: 'e0000000-0000-4000-8000-000000000004' }],
    ['wrong-role', { g_role: 'NURSING_STAFF' }],
  ])('does not mint a delegated ticket for an %s guardian', async (_label, lifecycle) => {
    const response = await mintFor(dependentRow(lifecycle));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_AUTHORISED_TO_ACT_AS');
    expect(generateTokenMock).not.toHaveBeenCalled();
  });

  it('mints for a live dependent and preserves the guardian session binding', async () => {
    const response = await mintFor(dependentRow());

    expect(response.status).toBe(200);
    expect(generateTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: DEPENDENT_UID,
        revocationOwnerUid: GUARDIAN_UID,
        sessionFamilyId: 'guardian-session-family',
        stableDeviceId: 'guardian-device',
      }),
      '60s',
    );
  });
});
