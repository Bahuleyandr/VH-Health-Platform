import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for burnRoutes.js — relay-variants port of
// the wrap() catch onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old catch
// passed err.details as the 4th arg but dropped err.code entirely; the relay
// lifts err.code to the envelope root and keeps err.details under `details`.

const listBurnChartsMock = jest.fn();
const createBurnChartMock = jest.fn();
const getBurnChartMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/burnCareService.js', () => ({
  listBurnCharts: listBurnChartsMock,
  createBurnChart: createBurnChartMock,
  getBurnChart: getBurnChartMock,
  recordTbsaRegions: jest.fn(),
  recordReassessment: jest.fn(),
  recordFluidWorksheet: jest.fn(),
  listProtocolContentLinks: jest.fn(),
  linkProtocolContent: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: burnRoutes } = await import('../../routes/clinical/burnRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/burns', burnRoutes);

beforeEach(() => {
  listBurnChartsMock.mockReset();
  createBurnChartMock.mockReset();
  getBurnChartMock.mockReset();
});

describe('burn route wrap() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    createBurnChartMock.mockRejectedValueOnce(
      AppError.conflict('An active burn chart already exists for this admission', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/burns/charts')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('bare AppError (code, no details) lifts the code to the root without a details key', async () => {
    // Pre-port this site forwarded only err.details (4th arg) and dropped
    // err.code entirely — pin the new wire shape for the burn family.
    getBurnChartMock.mockRejectedValueOnce(
      AppError.notFound('Burn chart not found', 'BURN_CHART_NOT_FOUND'),
    );

    const response = await request(app).get('/api/v1/burns/charts/42');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('BURN_CHART_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listBurnChartsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'tbsa_percent')"),
    );

    const response = await request(app).get('/api/v1/burns/charts');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An internal server error occurred. Please try again later.');
    expect(response.body.message).not.toMatch(/tbsa_percent/);
  });
});
