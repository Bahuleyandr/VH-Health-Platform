import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// transplant handleFailure (previously `err.details ?? { code: err.code }`).

const getDashboardMock = jest.fn();

jest.unstable_mockModule('../../services/transplant/transplantProgramService.js', () => ({
  createProgram: jest.fn(),
  createCandidate: jest.fn(),
  recordWaitlistStatus: jest.fn(),
  createDonorReferral: jest.fn(),
  createMatchReview: jest.fn(),
  createCommitteeReview: jest.fn(),
  createImmunosuppressionPlan: jest.fn(),
  createNottoExport: jest.fn(),
  releaseNottoExport: jest.fn(),
  getDashboard: getDashboardMock,
}));

jest.unstable_mockModule('../../services/transplant/transplantProgramFeatureService.js', () => ({
  isTransplantProgramEnabled: jest.fn(async () => true),
}));

const { default: transplantRoutes } = await import('../../routes/transplant/transplantRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'ADMIN',
    tenantId: '00000000-0000-4000-8000-000000000001',
  };
  next();
});
app.use('/api/v1/transplant', transplantRoutes);

beforeEach(() => {
  getDashboardMock.mockReset();
});

describe('transplant handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    getDashboardMock.mockRejectedValueOnce(AppError.conflict(
      'Transplant program is not enabled for this tenant',
      'TRANSPLANT_PROGRAM_DISABLED',
      { organ: 'kidney' },
    ));

    const response = await request(app).get('/api/v1/transplant/dashboard');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('TRANSPLANT_PROGRAM_DISABLED');
    expect(response.body.details).toEqual({ organ: 'kidney' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    getDashboardMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/transplant/dashboard');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to read dashboard');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
