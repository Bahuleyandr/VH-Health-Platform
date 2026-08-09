import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the dietary sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// dietaryRoutes.js guards every catch with `err.isOperational` and used to
// relay operational errors as `error(res, err.message, err.statusCode)` with
// no 4th arg, dropping `err.code` and `err.details` on the wire. The port to
// relayAppError() must forward both, while the non-operational tail
// (logger.error + next(err)) stays byte-identical so the global handler and
// Sentry keep seeing programming errors.

const createDietOrderMock = jest.fn();
const getDietWorklistMock = jest.fn();
const updateDietPlanMock = jest.fn();
const getPatientDietHistoryMock = jest.fn();

jest.unstable_mockModule('../../services/dietary/dietaryService.js', () => ({
  default: {
    createDietOrder: createDietOrderMock,
    getDietWorklist: getDietWorklistMock,
    updateDietPlan: updateDietPlanMock,
    getPatientDietHistory: getPatientDietHistoryMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: dietaryRoutes } = await import('../../routes/dietary/dietaryRoutes.js');

const capturedErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/dietary', dietaryRoutes);
// Trailing error middleware standing in for the app's global handler — the
// routes' non-operational tail must keep forwarding via next(err).
app.use((err, _req, res, _next) => {
  capturedErrors.push(err);
  res.status(500).json({ success: false, message: 'Global handler generic message' });
});

beforeEach(() => {
  createDietOrderMock.mockReset();
  getDietWorklistMock.mockReset();
  updateDietPlanMock.mockReset();
  getPatientDietHistoryMock.mockReset();
  capturedErrors.length = 0;
});

describe('dietary routes relay AppError code + details', () => {
  test('operational AppError carries code + details over HTTP', async () => {
    createDietOrderMock.mockRejectedValueOnce(AppError.conflict(
      'An active diet order already exists for this encounter',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/dietary/orders')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        diet_type: 'diabetic',
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An active diet order already exists for this encounter');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(capturedErrors).toHaveLength(0);
  });

  test('an AppError without details produces no details key', async () => {
    getDietWorklistMock.mockRejectedValueOnce(AppError.notFound(
      'Diet worklist window not found',
      'DIET_WORKLIST_NOT_FOUND',
    ));

    const response = await request(app).get('/api/v1/dietary/worklist');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('DIET_WORKLIST_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    getPatientDietHistoryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'diet_type')"),
    );

    const response = await request(app)
      .get('/api/v1/dietary/patient/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Global handler generic message');
    expect(JSON.stringify(response.body)).not.toMatch(/diet_type/);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].message).toMatch(/diet_type/);
  });

  test('a statusCode-bearing but non-operational error is NOT relayed (predicate preserved)', async () => {
    const err = new Error('teapot from a library, not an AppError');
    err.statusCode = 418;
    updateDietPlanMock.mockRejectedValueOnce(err);

    const response = await request(app)
      .put('/api/v1/dietary/12')
      .send({ diet_type: 'RENAL' });

    // isOperational is the file's guard — err.statusCode alone must still go
    // down the logger + next(err) tail.
    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Global handler generic message');
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBe(err);
  });
});
