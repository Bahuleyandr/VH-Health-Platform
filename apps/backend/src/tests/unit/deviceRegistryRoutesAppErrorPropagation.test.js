import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// device-registry handleFailure (previously `err.details ?? { code: err.code }`).

const listDevicesMock = jest.fn();

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

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
}));

const { default: deviceRegistryRoutes } = await import('../../routes/admin/deviceRegistryRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/admin/devices', deviceRegistryRoutes);

beforeEach(() => {
  listDevicesMock.mockReset();
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
