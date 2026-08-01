import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// device-vitals handleFailure (previously `err.details ?? { code: err.code }`).

const listUnverifiedDeviceVitalsMock = jest.fn();
const ingestSequencedDeviceVitalsRecoveryMock = jest.fn();

jest.unstable_mockModule('../../services/emr/deviceVitalsService.js', () => ({
  ingestDeviceVitals: jest.fn(),
  ingestSequencedDeviceVitalsRecovery: ingestSequencedDeviceVitalsRecoveryMock,
  listUnverifiedDeviceVitals: listUnverifiedDeviceVitalsMock,
  readI09GatewayRecoveryResumeState: jest.fn(),
  resolveDeviceForGateway: jest.fn(),
  verifyDeviceVitals: jest.fn(),
}));

jest.unstable_mockModule('../../services/devices/deviceRegistryService.js', () => ({
  listDevices: jest.fn(),
}));

jest.unstable_mockModule('../../services/devices/deviceAssociationService.js', () => ({
  associateDevicePatient: jest.fn(),
  disconnectAssociation: jest.fn(),
  listAssociations: jest.fn(),
}));

const { default: deviceVitalsRoutes } = await import('../../routes/emr/deviceVitalsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: req.get('x-test-role') || 'NURSING_STAFF',
  };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/devices', deviceVitalsRoutes);

beforeEach(() => {
  listUnverifiedDeviceVitalsMock.mockReset();
  ingestSequencedDeviceVitalsRecoveryMock.mockReset();
});

describe('device vitals handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listUnverifiedDeviceVitalsMock.mockRejectedValueOnce(AppError.conflict(
      'Device vitals row is already verified',
      'DEVICE_VITALS_ALREADY_VERIFIED',
      { vitals_id: 12 },
    ));

    const response = await request(app).get('/api/v1/devices/vitals/unverified');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('DEVICE_VITALS_ALREADY_VERIFIED');
    expect(response.body.details).toEqual({ vitals_id: 12 });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listUnverifiedDeviceVitalsMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/devices/vitals/unverified');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list unverified device vitals');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });

  test('I09 recovery rejects unknown outer-envelope fields before adapter dispatch', async () => {
    const response = await request(app)
      .post('/api/v1/devices/vitals/ingest')
      .set('x-test-role', 'DEVICE_GATEWAY')
      .send({ message: 'MSH|', recovery: {}, inferred_head: true });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('EXTERNAL_RECOVERY_ENVELOPE_REFUSED');
    expect(ingestSequencedDeviceVitalsRecoveryMock).not.toHaveBeenCalled();
  });

  test('I09 adapter refusal preserves the missing-marker code', async () => {
    ingestSequencedDeviceVitalsRecoveryMock.mockRejectedValueOnce(AppError.conflict(
      'Canonical I09 recovery marker is missing; owner reconciliation is required',
      'EXTERNAL_RECOVERY_MARKER_MISSING',
    ));

    const response = await request(app)
      .post('/api/v1/devices/vitals/ingest')
      .set('x-test-role', 'DEVICE_GATEWAY')
      .send({ message: 'MSH|', recovery: {} });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('EXTERNAL_RECOVERY_MARKER_MISSING');
  });
});
