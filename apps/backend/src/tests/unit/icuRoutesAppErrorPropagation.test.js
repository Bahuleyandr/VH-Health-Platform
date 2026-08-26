import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// icuRoutes.js wraps every handler in a local `wrap()` whose catch used to
// call `error(res, err.message, err.statusCode)` with no 4th arg — dropping
// `err.code` and `err.details` from the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). The port
// delegates to responseHelper.relayAppError, preserving this file's generic
// 500 message. These tests drive the endpoints over HTTP (supertest) and
// assert the response body itself.

const createAdmissionMock = jest.fn();
const listAdmissionsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/icuService.js', () => ({
  createAdmission: createAdmissionMock,
  listAdmissions: listAdmissionsMock,
}));

// Namespace-imported by the route file; none of their routes are exercised.
// VERIFIABLE_RESOURCES is additionally a named import (the NICU verify
// selector resolves through the service's own allowlist).
jest.unstable_mockModule('../../services/clinical/icuChartingService.js', () => ({}));
jest.unstable_mockModule('../../services/clinical/nicuPicuChartingService.js', () => ({
  VERIFIABLE_RESOURCES: {},
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitIcuBoardEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Re-audit M: these routers now carry per-route patientAccessGuard selectors
// (middleware/routePatientAccessGuards.js). This suite pins the route layer's
// error-envelope contract, not authz — neutralize the guard layer so requests
// reach the handlers. Guard wiring and selector behavior are pinned in
// perioperativeRouteGuards / icuDialysisRouteGuards / cathLabRouteGuards.
jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: () => (_req, _res, next) => next(),
  selectorTenantOf: () => null,
  positiveIntOrNull: () => null,
  positiveBigIntTextOrNull: () => null,
  PG_INT4_MAX: 2147483647,
  PG_INT8_MAX: 9223372036854775807n,
}));

const { default: icuRoutes } = await import('../../routes/clinical/icuRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/icu', icuRoutes);

beforeEach(() => {
  createAdmissionMock.mockReset();
  listAdmissionsMock.mockReset();
});

describe('icu route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    createAdmissionMock.mockRejectedValueOnce(AppError.conflict(
      'ICU bed is already occupied by an active admission',
      'ICU_BED_ALREADY_OCCUPIED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/icu/admissions')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', bed_number: 'ICU-4' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('ICU bed is already occupied by an active admission');
    expect(response.body.code).toBe('ICU_BED_ALREADY_OCCUPIED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    listAdmissionsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'unit_code')"),
    );

    const response = await request(app)
      .get('/api/v1/icu/admissions');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An internal server error occurred. Please try again later.');
    expect(response.body.message).not.toMatch(/unit_code/);
  });
});
