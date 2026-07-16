import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// cold-chain handleFailure (previously `err.details ?? { code: err.code }`).

const listColdChainDashboardMock = jest.fn();

jest.unstable_mockModule('../../services/devices/coldChainService.js', () => ({
  acknowledgeColdChainExcursion: jest.fn(),
  createColdChainUnit: jest.fn(),
  exportTemperatureRegister: jest.fn(),
  ingestColdChainReading: jest.fn(),
  listColdChainDashboard: listColdChainDashboardMock,
  listColdChainUnits: jest.fn(),
  recordColdChainCorrectiveAction: jest.fn(),
  runSilentSensorWatchdog: jest.fn(),
  updateColdChainUnit: jest.fn(),
}));

const { default: coldChainRoutes } = await import('../../routes/coldChainRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/cold-chain', coldChainRoutes);

beforeEach(() => {
  listColdChainDashboardMock.mockReset();
});

describe('cold-chain handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listColdChainDashboardMock.mockRejectedValueOnce(AppError.conflict(
      'Cold-chain unit is already decommissioned',
      'COLD_CHAIN_UNIT_DECOMMISSIONED',
      { unit_id: 7 },
    ));

    const response = await request(app).get('/api/v1/cold-chain/dashboard');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('COLD_CHAIN_UNIT_DECOMMISSIONED');
    expect(response.body.details).toEqual({ unit_id: 7 });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listColdChainDashboardMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/cold-chain/dashboard');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to load cold-chain dashboard');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
