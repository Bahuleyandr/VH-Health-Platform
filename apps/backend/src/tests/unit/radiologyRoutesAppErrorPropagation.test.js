import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port — the radiology
// twin of pathologyRoutesAppErrorPropagation.test.js. handleOperationalError
// previously sent `error(res, err.message, err.statusCode, err.details ??
// { code: err.code })`; the relay lifts err.code to the envelope root and
// nests err.details. Non-operational rejections keep the byte-identical
// logger + next(err) tail (gateway to the global handler/Sentry).

const getWorklistMock = jest.fn();

jest.unstable_mockModule('../../services/radiology/radiologyService.js', () => ({
  default: {
    getWorklist: getWorklistMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // requireTenantId is reached through the router's new per-route
  // patientAccessGuardForResource -> accessDecisionService import chain. An ESM
  // mock factory must provide EVERY export the graph imports, or the suite fails
  // to LOAD with "does not provide an export named ..." — which reads like a
  // missing test rather than a missing mock line.
  requireTenantId: (tenantId) => tenantId,
  // careTeamEnforcement reads the tenant to resolve care_team_enforcement_mode.
  // null makes it fall back to the env/default posture, which is 'shadow' — the
  // behaviour these suites already assume.
  getTenantById: async () => null,
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitRadiologyEvent: jest.fn(),
}));

const { default: radiologyRoutes } = await import('../../routes/radiology/radiologyRoutes.js');

const tailErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/radiology', radiologyRoutes);
app.use((err, _req, res, _next) => {
  tailErrors.push(err);
  res.status(500).json({ success: false, message: 'global handler' });
});

beforeEach(() => {
  getWorklistMock.mockReset();
  tailErrors.length = 0;
});

describe('radiology handleOperationalError relays AppError code + details', () => {
  test('operational AppError carries code at the root and forwards details', async () => {
    getWorklistMock.mockRejectedValueOnce(AppError.conflict(
      'Radiology order is already scheduled',
      'RADIOLOGY_ORDER_ALREADY_SCHEDULED',
      { order_id: 42 },
    ));

    const response = await request(app).get('/api/v1/radiology/worklist');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('RADIOLOGY_ORDER_ALREADY_SCHEDULED');
    expect(response.body.details).toEqual({ order_id: 42 });
    expect(response.body.requestId).toBe('test-request-id');
    expect(tailErrors).toHaveLength(0);
  });

  test('operational AppError without details produces root code and NO details key', async () => {
    getWorklistMock.mockRejectedValueOnce(new AppError(
      'Radiology worklist filter is invalid',
      422,
      'RADIOLOGY_FILTER_INVALID',
    ));

    const response = await request(app).get('/api/v1/radiology/worklist');

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('RADIOLOGY_FILTER_INVALID');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-operational error keeps the next(err) tail (global handler receives it)', async () => {
    const boom = new Error("Cannot read properties of undefined (reading 'modality')");
    getWorklistMock.mockRejectedValueOnce(boom);

    const response = await request(app).get('/api/v1/radiology/worklist');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('global handler');
    expect(response.body.message).not.toMatch(/modality/);
    expect(tailErrors).toHaveLength(1);
    expect(tailErrors[0]).toBe(boom);
  });
});
