import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of
// sosController.js (createEmergencyAlert + updateEmergencyContact catches —
// the only two sites in the file that relayed err.message/err.statusCode).
// Driven over HTTP through the real sosRoutes module, mirroring
// paediatricImmunisationRoutesAppErrorPropagation.test.js.

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const createAlertMock = jest.fn();
const updateContactsMock = jest.fn();

jest.unstable_mockModule('../../services/sosService.js', () => ({
  createAlert: createAlertMock,
  updateEmergencyContacts: updateContactsMock,
  getEmergencyContacts: jest.fn(async () => ({})),
  cancelAlert: jest.fn(async () => ({})),
  getMyAlerts: jest.fn(async () => []),
  getNearbyServices: jest.fn(async () => []),
  getMedicalInfo: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: jest.fn(async () => []),
    $queryRaw: jest.fn(async () => []),
  },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_ID,
  resolveTenantOrThrow: () => TENANT_ID,
}));

// wrapAutoRBAC shim: register the route map verbatim without RBAC-config,
// rate-limit, or audit plumbing (role gating is not under test here).
const registerRoutes = (router, routeMap) => {
  for (const [method, routes] of Object.entries(routeMap)) {
    for (const [path, ...handlers] of routes) {
      router[method](path, ...handlers.flat(Infinity));
    }
  }
};
jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAsync: (fn) => fn,
  wrapAutoRBAC: (router, _key, routeMap) => registerRoutes(router, routeMap),
  wrapRoutesWithValidation: (router, _roles, routeMap) => registerRoutes(router, routeMap),
}));
const passThrough = (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  sosRateLimiter: passThrough,
}));
jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeSosFields: passThrough,
}));
jest.unstable_mockModule('../../validators/sosValidators.js', () => ({
  createAlert: [],
  updateEmergencyContact: [],
  cancelAlert: [],
  getMyAlerts: [],
  getNearbyServices: [],
  respondToAlert: [],
  resolveAlert: [],
  getAnalytics: [],
  getAdminAnalytics: [],
  getAdminAlerts: [],
  getPerformanceReport: [],
  updateConfig: [],
  broadcastAlert: [],
  escalateAlert: [],
}));

const { default: sosRoutes } = await import('../../routes/sosRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = TENANT_ID;
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: req.headers['x-test-role'] || 'PATIENT',
    phone: '9876543210',
  };
  next();
});
app.use('/api/v1/sos', sosRoutes);

beforeEach(() => {
  createAlertMock.mockReset();
  updateContactsMock.mockReset();
});

describe('sosController relays AppError code + details over HTTP', () => {
  test('patient callers cannot suppress a real SOS by marking it as a drill', async () => {
    const response = await request(app)
      .post('/api/v1/sos/')
      .send({ latitude: 12.9716, longitude: 77.5946, isTestAlert: true });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('SOS_DRILL_ROLE_REQUIRED');
    expect(createAlertMock).not.toHaveBeenCalled();
  });

  test('an admin drill carries server-derived actor provenance', async () => {
    createAlertMock.mockResolvedValueOnce({ alert_id: 42, is_test: true });

    const response = await request(app)
      .post('/api/v1/sos/')
      .set('x-test-role', 'ADMIN')
      .send({
        latitude: 12.9716,
        longitude: 77.5946,
        isTestAlert: true,
        drillAuthorization: {
          actorUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          actorRole: 'SUPER_ADMIN',
        },
      });

    expect(response.statusCode).toBe(200);
    expect(createAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      isTestAlert: true,
      drillAuthorization: {
        actorUid: '11111111-1111-4111-8111-111111111111',
        actorRole: 'ADMIN',
      },
    }));
  });

  test('createEmergencyAlert relays an AppError with code and details (409)', async () => {
    createAlertMock.mockRejectedValueOnce(AppError.conflict(
      'An active SOS alert already exists',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/sos/')
      .send({ latitude: 12.9716, longitude: 77.5946 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An active SOS alert already exists');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('createEmergencyAlert returns its generic 500 for a non-AppError and never leaks err.message', async () => {
    createAlertMock.mockRejectedValueOnce(new Error('twilio auth token rejected'));

    const response = await request(app)
      .post('/api/v1/sos/')
      .send({ latitude: 12.9716, longitude: 77.5946 });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe(
      'Failed to process emergency alert. Please call emergency services directly.',
    );
    expect(response.body.message).not.toMatch(/twilio/);
  });

  test('updateEmergencyContact relays the self-service 403 byte-identically with no code key', async () => {
    // resolveSelfServicePhone's own bare-statusCode Error shape: requested
    // phone differs from the token phone.
    const response = await request(app)
      .post('/api/v1/sos/emergency-contact')
      .send({ phone: '9123456780', contacts: [] });

    expect(response.statusCode).toBe(403);
    expect(response.body.message).toBe('Can only manage SOS data for yourself');
    expect(response.body).not.toHaveProperty('code');
    expect(response.body).not.toHaveProperty('details');
    expect(updateContactsMock).not.toHaveBeenCalled();
  });

  test('updateEmergencyContact returns its generic 500 for a non-AppError and never leaks err.message', async () => {
    updateContactsMock.mockRejectedValueOnce(new Error('jsonb parse failure in contacts column'));

    const response = await request(app)
      .post('/api/v1/sos/emergency-contact')
      .send({ contacts: [] });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to update emergency contact information');
    expect(response.body.message).not.toMatch(/jsonb/);
  });
});
