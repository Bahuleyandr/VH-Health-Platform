import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// result-release handleFailure (previously `err.details ?? { code: err.code }`).

const setResultReleaseHoldMock = jest.fn();

jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  setResultReleaseHold: setResultReleaseHoldMock,
  releaseResultNow: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  requireTenantId: jest.fn((v) => v ?? '00000000-0000-4000-8000-000000000001'),
}));

// Pass-through: resultReleaseRoutes now applies patientAccessGuard per route
// (the 2026-08 mount-guard conversion). The guard's own decide/deny behavior
// is pinned by labPathologyNursingRouteGuards.test.js; this suite tests the
// handlers' error-envelope contract, which the guard must not intercept —
// and the real guard would query the DB from a unit suite.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

const { default: resultReleaseRoutes } = await import('../../routes/lab/resultReleaseRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/lab/release', resultReleaseRoutes);

beforeEach(() => {
  setResultReleaseHoldMock.mockReset();
});

describe('result release handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    setResultReleaseHoldMock.mockRejectedValueOnce(AppError.conflict(
      'Result is already released to the patient',
      'RESULT_ALREADY_RELEASED',
      { result_id: 5 },
    ));

    const response = await request(app)
      .patch('/api/v1/lab/release/5/hold')
      .send({ hold: true });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('RESULT_ALREADY_RELEASED');
    expect(response.body.details).toEqual({ result_id: 5 });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    setResultReleaseHoldMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app)
      .patch('/api/v1/lab/release/5/hold')
      .send({ hold: true });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to update release hold');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
