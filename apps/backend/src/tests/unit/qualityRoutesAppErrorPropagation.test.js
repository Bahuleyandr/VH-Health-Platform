import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for qualityRoutes.js (relayAppError port).
//
// Every catch in qualityRoutes.js guards on `err.isOperational` and relayed
// AppErrors via `error(res, err.message, err.statusCode)` with no 4th arg,
// dropping `err.code` and `err.details` on the wire. The port swaps only the
// operational branch for the shared relay (responseHelper.relayAppError) and
// keeps the non-operational tail (logger + next(err)) byte-identical — these
// are gateway surfaces where global-handler/Sentry visibility is deliberate.

const getIncidentsMock = jest.fn();
const updateIncidentMock = jest.fn();
const getQualityDashboardMock = jest.fn();

jest.unstable_mockModule('../../services/quality/qualityService.js', () => ({
  default: {
    reportIncident: jest.fn(),
    getIncidents: getIncidentsMock,
    updateIncident: updateIncidentMock,
    getQualityDashboard: getQualityDashboardMock,
    reportInfectionCase: jest.fn(),
    getInfectionSurveillance: jest.fn(),
    getOutbreakAlerts: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/feedback/npsService.js', () => ({
  getNpsDashboard: jest.fn(async () => ({})),
  listServiceRecoveryTasks: jest.fn(async () => ({ tasks: [], count: 0 })),
  refreshNpsRollups: jest.fn(async () => ({})),
}));

const { default: qualityRoutes } = await import('../../routes/quality/qualityRoutes.js');

const tailSpy = jest.fn();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/quality', qualityRoutes);
// Stand-in for the global error handler — pins the preserved next(err) tail.
app.use((err, _req, res, _next) => {
  tailSpy(err);
  res.status(500).json({ success: false, message: 'Handled by global error middleware' });
});

beforeEach(() => {
  getIncidentsMock.mockReset();
  updateIncidentMock.mockReset();
  getQualityDashboardMock.mockReset();
  tailSpy.mockReset();
});

describe('quality route catches relay AppError code + details', () => {
  test('operational AppError carries code and details over HTTP', async () => {
    getIncidentsMock.mockRejectedValueOnce(AppError.conflict('msg', 'SOME_CODE', { reason: 'x' }));

    const response = await request(app).get('/api/v1/quality/incidents');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('msg');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(tailSpy).not.toHaveBeenCalled();
  });

  test('operational AppError without details produces no details key', async () => {
    getQualityDashboardMock.mockRejectedValueOnce(
      new AppError('Quality dashboard is unavailable for this tenant', 422, 'QUALITY_DASHBOARD_UNAVAILABLE'),
    );

    const response = await request(app).get('/api/v1/quality/dashboard');

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('QUALITY_DASHBOARD_UNAVAILABLE');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-operational error keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    const boom = new Error("Cannot read properties of undefined (reading 'incident_type')");
    updateIncidentMock.mockRejectedValueOnce(boom);

    const response = await request(app)
      .put('/api/v1/quality/incidents/12')
      .send({ status: 'investigating' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Handled by global error middleware');
    expect(response.body.message).not.toMatch(/incident_type/);
    expect(tailSpy).toHaveBeenCalledTimes(1);
    expect(tailSpy.mock.calls[0][0]).toBe(boom);
  });
});
