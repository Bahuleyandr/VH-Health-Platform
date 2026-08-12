import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_UID = '00000000-0000-4000-8000-0000000000b2';
const queryRawUnsafe = jest.fn();
const registerNotificationDevice = jest.fn();
const rotateNotificationDeviceToken = jest.fn();
const validateNotificationAuthority = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  setTenant: async (_tenantId, callback) => callback({ $queryRawUnsafe: queryRawUnsafe }),
  setTenantTx: async (_tenantId, callback) => callback({ $queryRawUnsafe: queryRawUnsafe }),
  pickTenantClient: () => ({ $queryRawUnsafe: queryRawUnsafe }),
}));
jest.unstable_mockModule('../../services/notification/deviceRegistrationService.js', () => ({
  registerNotificationDevice,
  rotateNotificationDeviceToken,
  validateNotificationAuthority,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/validateApiKey.js', () => ({
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../controllers/deviceController.js', () => ({
  registerDevice: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT_ID,
}));
jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAsync: (fn) => fn,
  wrapAutoRBAC: (router, _configKey, routeMap) => {
    for (const [method, routes] of Object.entries(routeMap)) {
      for (const [path, ...handlers] of routes) router[method](path, ...handlers);
    }
    return router;
  },
}));

const { default: deviceRoutes } = await import('../../routes/deviceRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: USER_UID, role: 'NURSING_STAFF', name: 'Nurse One', jti: 'current-jti' };
  next();
});
app.use('/api/v1/devices', deviceRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafe.mockResolvedValue([{
    uid: USER_UID,
    tenant_id: TENANT_ID,
    phone: '+919999900000',
    name: 'Nurse One',
  }]);
});

describe('notification device routes', () => {
  it.each([
    [true, 'registered'],
    [false, 'updated'],
  ])('preserves /register response fields when new=%s', async (isNewRegistration, verb) => {
    registerNotificationDevice.mockResolvedValue({
      id: 29,
      device_name: 'Ward handset',
      is_new_registration: isNewRegistration,
      notification_authority: {
        version: 1,
        tenantId: TENANT_ID,
        recipientUid: USER_UID,
        deviceId: 'installation-1',
        registrationEpoch: '3',
        sessionEpoch: 'session-family-1',
        authorizationEpoch: '8',
        sessionExpiresAt: '2030-01-01T00:00:00.000Z',
      },
    });

    const response = await request(app).post('/api/v1/devices/register').send({
      phone: '+919999900000',
      deviceId: 'installation-1',
      fcmToken: 'token-1',
      deviceName: 'Ward handset',
      platform: 'android',
      appVersion: '1.2.3',
      osVersion: '16',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe(`Device ${verb} successfully`);
    expect(response.body.data).toMatchObject({
      deviceRegistrationId: 29,
      phone: '+919999900000',
      deviceId: 'installation-1',
      deviceName: 'Ward handset',
      isNewRegistration,
      registeredBy: 'Nurse One',
      notificationAuthority: expect.objectContaining({ registrationEpoch: '3' }),
    });
    expect(response.body.data.registeredAt).toEqual(expect.any(String));
    expect(registerNotificationDevice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      fcmToken: 'token-1',
      deviceName: 'Ward handset',
      platform: 'android',
      appVersion: '1.2.3',
      osVersion: '16',
      sessionJti: 'current-jti',
    });
  });

  it('keeps registration database failures fail-honest and generic', async () => {
    registerNotificationDevice.mockRejectedValue(new Error('cross-tenant detail'));

    const response = await request(app).post('/api/v1/devices/register').send({
      deviceId: 'installation-1',
      fcmToken: 'token-1',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to register device');
    expect(JSON.stringify(response.body)).not.toContain('cross-tenant detail');
  });

  it('preserves /update-token success fields through the update-only adapter', async () => {
    rotateNotificationDeviceToken.mockResolvedValue({
      id: 29,
      device_name: 'Ward handset',
      is_new_registration: false,
      notification_authority: {
        version: 1,
        tenantId: TENANT_ID,
        recipientUid: USER_UID,
        deviceId: 'installation-1',
        registrationEpoch: '4',
        sessionEpoch: 'session-family-1',
        authorizationEpoch: '8',
        sessionExpiresAt: '2030-01-01T00:00:00.000Z',
      },
    });

    const response = await request(app).post('/api/v1/devices/update-token').send({
      deviceId: 'installation-1',
      fcmToken: 'token-2',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe('FCM token updated successfully');
    expect(response.body.data).toMatchObject({
      phone: '+919999900000',
      deviceId: 'installation-1',
      deviceName: 'Ward handset',
      tokenUpdated: true,
      updatedBy: 'Nurse One',
      notificationAuthority: expect.objectContaining({ registrationEpoch: '4' }),
    });
    expect(response.body.data.updatedAt).toEqual(expect.any(String));
    expect(rotateNotificationDeviceToken).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      fcmToken: 'token-2',
      sessionJti: 'current-jti',
    });
  });

  it('fails closed when a delayed notification audience is not current', async () => {
    validateNotificationAuthority.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/v1/devices/notification-authority/validate')
      .send({
        tenantId: TENANT_ID,
        recipientUid: USER_UID,
        deviceId: 'installation-1',
        registrationEpoch: '2',
        sessionEpoch: 'old-session-family',
        authorizationEpoch: '7',
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual({ authorized: false });
    expect(validateNotificationAuthority).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      sessionJti: 'current-jti',
      deviceId: 'installation-1',
      registrationEpoch: '2',
      sessionEpoch: 'old-session-family',
      authorizationEpoch: '7',
    });
  });

  it('keeps /update-token absent exact projection as 404', async () => {
    rotateNotificationDeviceToken.mockResolvedValue(undefined);

    const response = await request(app).post('/api/v1/devices/update-token').send({
      deviceId: 'missing-installation',
      fcmToken: 'token-2',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.message).toBe('Device not found or access denied');
  });
});
