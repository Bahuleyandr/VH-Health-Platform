import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// device-registry handleFailure (previously `err.details ?? { code: err.code }`).

const listDevicesMock = jest.fn();
const assertClinicalContinuityDeviceLossActivatedMock = jest.fn();
const orchestrateClinicalContinuityDeviceLossMock = jest.fn();

jest.unstable_mockModule('../../services/devices/deviceRegistryService.js', () => ({
  createDevice: jest.fn(),
  getDeviceById: jest.fn(),
  listDevices: listDevicesMock,
  rotateDeviceCredential: jest.fn(),
  updateDevice: jest.fn(),
}));

jest.unstable_mockModule('../../services/devices/deviceAssociationService.js', () => ({
  listAssociations: jest.fn(),
}));

jest.unstable_mockModule('../../services/emr/deviceVitalsService.js', () => ({
  ingestDeviceVitals: jest.fn(),
}));

jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityFacilityContextService.js',
  () => ({
    enrollClinicalContinuityFacilityGrant: jest.fn(),
    listClinicalContinuityFacilityGrants: jest.fn(),
    revokeClinicalContinuityFacilityGrant: jest.fn(),
  }),
);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
}));

jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityDeviceLossService.js',
  () => ({
    assertClinicalContinuityDeviceLossActivated: assertClinicalContinuityDeviceLossActivatedMock,
    orchestrateClinicalContinuityDeviceLoss: orchestrateClinicalContinuityDeviceLossMock,
  }),
);

const { default: deviceRegistryRoutes } = await import('../../routes/admin/deviceRegistryRoutes.js');

const app = express();
app.use(express.json());
// The caller is a plain tenant ADMIN by default. jwtMiddleware canonicalises a
// SUPER_ADMIN claim down to `role: 'ADMIN'` and keeps the original claim on
// `rawRole` (utils/roles.js `canonicalizeRequestRole`), so a genuine super-admin
// request differs from an ADMIN's ONLY in `rawRole` — `x-test-raw-role`
// reproduces exactly that shape rather than an invented `role: 'SUPER_ADMIN'`.
// The continuity facility-context routes now sit on requireRole('SUPER_ADMIN'),
// which is satisfied by `rawRole`.
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'ADMIN',
    rawRole: req.get('x-test-raw-role') || 'ADMIN',
    scope: 'full',
  };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/admin/devices', deviceRegistryRoutes);

beforeEach(() => {
  listDevicesMock.mockReset();
  assertClinicalContinuityDeviceLossActivatedMock.mockReset();
  orchestrateClinicalContinuityDeviceLossMock.mockReset();
});

describe('device registry handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listDevicesMock.mockRejectedValueOnce(AppError.conflict(
      'Device code already registered',
      'DEVICE_CODE_DUPLICATE',
      { device_code: 'ICU-MON-1' },
    ));

    const response = await request(app).get('/api/v1/admin/devices');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('DEVICE_CODE_DUPLICATE');
    expect(response.body.details).toEqual({ device_code: 'ICU-MON-1' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listDevicesMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/admin/devices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list devices');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});

const CONTINUITY_FACILITY_ROUTES = [
  ['get', '/continuity-facility-context/grants'],
  ['post', '/continuity-facility-context/enroll'],
  ['post', '/continuity-facility-context/revoke'],
];

describe('continuity facility enrollment stays activation locked', () => {
  // Asserted as SUPER_ADMIN so the activation gate is what answers: the role
  // gate in front of it would otherwise mask the 503 with a 403.
  test.each(CONTINUITY_FACILITY_ROUTES)(
    '%s %s is unavailable to a SUPER_ADMIN while C-D14 is open',
    async (method, path) => {
      const response = await request(app)[method](
        `/api/v1/admin/devices${path}`,
      ).set('x-test-raw-role', 'SUPER_ADMIN').send({});

      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({
        code: 'CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE',
        success: false,
      });
    },
  );
});

describe('continuity facility-context route authority', () => {
  test.each(CONTINUITY_FACILITY_ROUTES)(
    '%s %s refuses an ordinary ADMIN before the activation gate',
    async (method, path) => {
      const response = await request(app)[method](
        `/api/v1/admin/devices${path}`,
      ).send({});

      // 403 rather than the 503 above: the role gate runs first, so an ADMIN
      // never learns the activation state of the facility-context console.
      expect(response.statusCode).toBe(403);
      expect(response.body.code).not.toBe(
        'CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE',
      );
    },
  );
});

describe('continuity device-loss route authority', () => {
  test('rejects an ordinary ADMIN before activation or orchestration', async () => {
    const response = await request(app)
      .post('/api/v1/admin/devices/continuity-device-loss')
      .set('Idempotency-Key', 'device-loss-rbac-test')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(assertClinicalContinuityDeviceLossActivatedMock).not.toHaveBeenCalled();
    expect(orchestrateClinicalContinuityDeviceLossMock).not.toHaveBeenCalled();
  });
});
