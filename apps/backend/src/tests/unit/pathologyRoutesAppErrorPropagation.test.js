import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port.
//
// pathologyRoutes.js routes guard `if (err.isOperational)` and delegate to a
// shared handleOperationalError(res, err), which previously sent
// `error(res, err.message, err.statusCode, err.details ?? { code: err.code })`
// — leaving `err.code` buried under `details.code` and never at the envelope
// root. The port relays through relayAppError, which lifts `err.code` to the
// response root and nests `err.details` under `details`. Non-operational
// errors keep the original tail byte-identical: logger + next(err) so the
// global handler/Sentry still see them.

const getWorklistMock = jest.fn();

jest.unstable_mockModule('../../services/pathology/pathologyService.js', () => ({
  default: {
    getWorklist: getWorklistMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  requireTenantId: jest.fn((v) => v ?? '00000000-0000-4000-8000-000000000001'),
}));

// Pass-through: pathologyRoutes now applies patientAccessGuard per route (the
// 2026-08 mount-guard conversion). The guard's own decide/deny behavior is
// pinned by labPathologyNursingRouteGuards.test.js; this suite tests the
// handlers' error-envelope contract, which the guard must not intercept —
// and the real guard would query the DB from a unit suite.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitPathologyEvent: jest.fn(),
}));

const { default: pathologyRoutes } = await import('../../routes/pathology/pathologyRoutes.js');

const tailErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/pathology', pathologyRoutes);
// Stand-in for the app-level global error handler: the non-operational tail
// must still reach it via next(err).
app.use((err, _req, res, _next) => {
  tailErrors.push(err);
  res.status(500).json({ success: false, message: 'global handler' });
});

beforeEach(() => {
  getWorklistMock.mockReset();
  tailErrors.length = 0;
});

describe('pathology handleOperationalError relays AppError code + details', () => {
  test('operational AppError carries code at the root and forwards details', async () => {
    getWorklistMock.mockRejectedValueOnce(AppError.conflict(
      'Pathology case is already accessioned',
      'PATHOLOGY_CASE_ALREADY_ACCESSIONED',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/pathology/worklist');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PATHOLOGY_CASE_ALREADY_ACCESSIONED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(tailErrors).toHaveLength(0);
  });

  test('operational AppError without details produces root code and NO details key', async () => {
    // Pre-port wire shape was `details: { code: ... }`; the relay lifts the
    // code to the envelope root and must not emit a spurious details object.
    getWorklistMock.mockRejectedValueOnce(new AppError(
      'Pathology worklist filter is invalid',
      422,
      'PATHOLOGY_FILTER_INVALID',
    ));

    const response = await request(app).get('/api/v1/pathology/worklist');

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('PATHOLOGY_FILTER_INVALID');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-operational error keeps the next(err) tail (global handler receives it)', async () => {
    const boom = new Error("Cannot read properties of undefined (reading 'case_kind')");
    getWorklistMock.mockRejectedValueOnce(boom);

    const response = await request(app).get('/api/v1/pathology/worklist');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('global handler');
    expect(response.body.message).not.toMatch(/case_kind/);
    expect(tailErrors).toHaveLength(1);
    expect(tailErrors[0]).toBe(boom);
  });
});
