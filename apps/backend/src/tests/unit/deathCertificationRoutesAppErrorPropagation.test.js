import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// deathCertificationRoutes.js wraps every handler in a local `wrap()` whose
// catch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg (dropping `err.code` + `err.details`) and relayed raw `err.message`
// on the generic-500 branch (`err.message || 'Death certification error'`).
// The port delegates to responseHelper.relayAppError, keeping the generic
// message and hardening the 500 branch to generic-only. These tests drive
// the endpoints over HTTP (supertest) and assert the response body itself.

const createDeathRecordMock = jest.fn();
const listDeathRecordsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/deathCertificationService.js', () => ({
  createDeathRecord: createDeathRecordMock,
  listDeathRecords: listDeathRecordsMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Re-audit 2026-08 (M: mount guards): the router now carries per-route
// patientAccessGuard middleware. This suite pins the route layer's own
// contract, not authz — stub the guard factory to a pass-through so the real
// accessDecisionService import graph (and its DB reads) stays out of scope.
// Guard wiring + selectors are pinned by deathCertificationRoutesPatientGuard.test.js.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

const { default: deathCertificationRoutes } = await import('../../routes/clinical/deathCertificationRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/death-certification', deathCertificationRoutes);

beforeEach(() => {
  createDeathRecordMock.mockReset();
  listDeathRecordsMock.mockReset();
});

describe('death-certification route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    createDeathRecordMock.mockRejectedValueOnce(AppError.conflict(
      'A death record already exists for this admission',
      'DEATH_RECORD_ALREADY_EXISTS',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/death-certification/records')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('A death record already exists for this admission');
    expect(response.body.code).toBe('DEATH_RECORD_ALREADY_EXISTS');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Death certification error'` —
    // the port hardens this to generic-only (raw messages leak on non-prod).
    listDeathRecordsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'death_datetime')"),
    );

    const response = await request(app)
      .get('/api/v1/death-certification/records');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Death certification error');
    expect(response.body.message).not.toMatch(/death_datetime/);
  });
});
