import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — dischargeRoutes member of the
// relayAppError sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation).
//
// dischargeRoutes.js `wrap()` built its wire shape with a local
// errorDetails(err) helper that nested err.code under `details.code`, and —
// worse — its non-operational tail relayed `err.message || 'Discharge summary
// error'`, leaking internals on non-prod deployments where sanitize passes
// 5xx messages through. Ported to responseHelper.relayAppError: code now
// reaches the envelope root and the 500 tail is generic-only.

const listPendingMock = jest.fn();
const signMock = jest.fn();

jest.unstable_mockModule('../../services/discharge/dischargeService.js', () => ({
  listTemplates: jest.fn(async () => []),
  createDraft: jest.fn(),
  listPending: listPendingMock,
  listForPatient: jest.fn(async () => []),
  generateSignedDischargeSummaryPdfBuffer: jest.fn(),
  getOne: jest.fn(),
  updateSection: jest.fn(),
  markReadyForSignoff: jest.fn(),
  sign: signMock,
  markDelivered: jest.fn(),
  setSectionTranslation: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Re-audit 2026-08 (M: mount guards): the router now carries per-route
// patientAccessGuard middleware. This suite pins the route layer's own
// contract, not authz — stub the guard factory to a pass-through so the real
// accessDecisionService import graph (and its DB reads) stays out of scope.
// Guard wiring + selectors are pinned by dischargeRoutesPatientGuard.test.js.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

const { default: dischargeRoutes } = await import('../../routes/discharge/dischargeRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // ADMIN passes both requireStaffOrAdmin and requireDoctorOrAdmin gates.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/discharge-summaries', dischargeRoutes);

beforeEach(() => {
  listPendingMock.mockReset();
  signMock.mockReset();
});

describe('discharge wrap() relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    signMock.mockRejectedValueOnce(AppError.conflict(
      'Summary must be marked ready before sign-off',
      'DISCHARGE_SUMMARY_NOT_READY',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/discharge-summaries/12/sign')
      .send({ signed_by_name: 'Dr Test' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Summary must be marked ready before sign-off');
    expect(response.body.code).toBe('DISCHARGE_SUMMARY_NOT_READY');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('AppError with a code but no details produces no details key at all', async () => {
    signMock.mockRejectedValueOnce(AppError.notFound(
      'Discharge summary not found',
      'DISCHARGE_SUMMARY_NOT_FOUND',
    ));

    const response = await request(app)
      .post('/api/v1/discharge-summaries/12/sign')
      .send({});

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('DISCHARGE_SUMMARY_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns the generic 500 — err.message no longer relayed', async () => {
    // The old tail was `error(res, err.message || 'Discharge summary error',
    // 500)` — the thrown text went over the wire on non-prod deployments.
    listPendingMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'summary_sections')"),
    );

    const response = await request(app).get('/api/v1/discharge-summaries/pending');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Discharge summary error');
    expect(response.body.message).not.toMatch(/summary_sections/);
  });
});
