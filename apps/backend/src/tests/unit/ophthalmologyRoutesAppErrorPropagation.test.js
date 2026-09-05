import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for ophthalmologyRoutes.js —
// relay-variants port of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const recordExamMock = jest.fn();
const getPatientHistoryMock = jest.fn();

// This is an ERROR-RELAY unit test, not a PHI authorization test. The route it
// exercises now carries a per-route patient guard, and that guard resolves the
// tenant's care-team enforcement mode through a LIVE `tenants` query before it
// does anything else — so without this mock the suite needs a reachable
// Postgres and fails 500 'Patient access check failed' without one. Mock it to
// a pass-through so this suite keeps testing what it is about; the guard's
// PRESENCE is asserted structurally by mountLevelPatientGuardCensus.test.js.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// An ESM mock factory must provide EVERY export the graph imports or the suite
// fails to LOAD, which reads like a missing test rather than a missing mock.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId,
  getTenantById: async (tenantId) => ({ id: tenantId, settings: {} }),
}));

jest.unstable_mockModule('../../services/clinical/ophthalmologyService.js', () => ({
  recordExam: recordExamMock,
  addRefraction: jest.fn(),
  getPatientHistory: getPatientHistoryMock,
  recordBiometry: jest.fn(),
  attachImaging: jest.fn(),
  generateSpectaclesPrescriptionPdf: jest.fn(),
}));

const { default: ophthalmologyRoutes } = await import('../../routes/clinical/ophthalmologyRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/ophthalmology', ophthalmologyRoutes);

beforeEach(() => {
  recordExamMock.mockReset();
  getPatientHistoryMock.mockReset();
});

describe('ophthalmology handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    recordExamMock.mockRejectedValueOnce(
      AppError.conflict('An exam already exists for this encounter', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/ophthalmology/exams')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    getPatientHistoryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'iop_mmhg')"),
    );

    const response = await request(app)
      .get('/api/v1/ophthalmology/patients/22222222-2222-4222-8222-222222222222/history');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to get ophthalmic history');
    expect(response.body.message).not.toMatch(/iop_mmhg/);
  });
});
