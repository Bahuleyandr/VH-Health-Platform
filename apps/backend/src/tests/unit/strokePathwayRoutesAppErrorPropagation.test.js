import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for strokePathwayRoutes.js —
// relay-variants port of the wrap() catch onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// The old catch built `{ code: err.code, details: err.details, safe: true }`
// as the 4th arg, which nested the machine code at `details.code` (and the
// service details at `details.details`). The relay lifts err.code to the
// envelope root and puts err.details directly under `details`, forwarding the
// site's confirmed-safe declaration via `{ safe: true }` — the flag the
// stroke deep suite's tolerant `body.details?.code || body.code` assertion
// already anticipates.
//
// NODE_ENV is forced to 'production' BEFORE the route module (and its
// responseHelper import) loads: safe:true forwarding is only observable in
// production, where an unsafe 5xx message is genericised. The logger keeps
// file transports silent in production, so no log files are written.
process.env.NODE_ENV = 'production';

const createActivationMock = jest.fn();
const listActivationsMock = jest.fn();
const getStrokePathwaySettingsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/strokePathwayService.js', () => ({
  createActivation: createActivationMock,
  getActivation: jest.fn(),
  getStrokePathwaySettings: getStrokePathwaySettingsMock,
  listActivations: listActivationsMock,
  recordNihssAssessment: jest.fn(),
  recordPathwayEvent: jest.fn(),
  recordThrombolysisDecision: jest.fn(),
  setStrokePathwaySettings: jest.fn(),
  updateActivationStatus: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: strokePathwayRoutes } = await import('../../routes/clinical/strokePathwayRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // DOCTOR passes requireStaffOrAdmin (isStaff).
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/stroke-pathway', strokePathwayRoutes);

beforeEach(() => {
  createActivationMock.mockReset();
  listActivationsMock.mockReset();
  getStrokePathwaySettingsMock.mockReset();
});

describe('stroke pathway wrap() relays AppError code + details with the safe flag', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    createActivationMock.mockRejectedValueOnce(
      AppError.conflict('An active stroke activation already exists for this patient', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/stroke-pathway/activations')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('safe:true keeps a hand-written AppError 5xx message through production sanitization', async () => {
    // Without the forwarded safe flag, production sanitization would replace
    // this 503 message with the generic 5xx text — pin the site's contract.
    getStrokePathwaySettingsMock.mockRejectedValueOnce(new AppError(
      'Stroke pathway settings backend is temporarily unavailable',
      503,
      'STROKE_SETTINGS_UNAVAILABLE',
    ));

    const response = await request(app).get('/api/v1/stroke-pathway/settings');

    expect(response.statusCode).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Stroke pathway settings backend is temporarily unavailable');
    expect(response.body.code).toBe('STROKE_SETTINGS_UNAVAILABLE');
    // The safe flag is consumed by error(), never serialized; no details on
    // this error → no details key at all.
    expect(response.body).not.toHaveProperty('safe');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listActivationsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'nihss_total')"),
    );

    const response = await request(app).get('/api/v1/stroke-pathway/activations');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An internal server error occurred. Please try again later.');
    expect(response.body.message).not.toMatch(/nihss_total/);
  });
});
