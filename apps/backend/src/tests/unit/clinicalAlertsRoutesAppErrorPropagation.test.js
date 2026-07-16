import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// clinicalAlertsRoutes.js wraps its handler in a local `wrap()` whose catch
// used to call `error(res, err.message, err.statusCode)` with no 4th arg —
// dropping `err.code` and `err.details` from the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). The port
// delegates to responseHelper.relayAppError, preserving this file's generic
// 500 message. These tests drive the endpoint over HTTP (supertest) and
// assert the response body itself.

const listRecentAlertsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/clinicalAlertsService.js', () => ({
  listRecentAlerts: listRecentAlertsMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: clinicalAlertsRoutes } = await import('../../routes/clinical/clinicalAlertsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/clinical-alerts', clinicalAlertsRoutes);

beforeEach(() => {
  listRecentAlertsMock.mockReset();
});

describe('clinical-alerts route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    listRecentAlertsMock.mockRejectedValueOnce(AppError.conflict(
      'Alert board snapshot superseded by a newer revision',
      'CLINICAL_ALERTS_SNAPSHOT_SUPERSEDED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .get('/api/v1/clinical-alerts/recent')
      .query({ hours: 8, limit: 10 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Alert board snapshot superseded by a newer revision');
    expect(response.body.code).toBe('CLINICAL_ALERTS_SNAPSHOT_SUPERSEDED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    listRecentAlertsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'acknowledged_at')"),
    );

    const response = await request(app)
      .get('/api/v1/clinical-alerts/recent');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An internal server error occurred. Please try again later.');
    expect(response.body.message).not.toMatch(/acknowledged_at/);
  });
});
