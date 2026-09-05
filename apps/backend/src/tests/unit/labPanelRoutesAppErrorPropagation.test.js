import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// labPanelRoutes.js wraps every handler in a local `wrap()` whose catch
// branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch called `error(res, err.message,
// err.statusCode)` with no 4th arg, dropping `err.code` and `err.details`.
// Non-AppErrors must return the file's hand-written generic 500 and never
// relay raw err.message (finding
// 2026-05-10-lab-walk-in-lab-tech-result-submit-500).

const recordLabPanelMock = jest.fn();
const getLabPanelMock = jest.fn();
const claimIdempotencyKeyMock = jest.fn();
const finaliseIdempotencyKeyMock = jest.fn();

jest.unstable_mockModule('../../services/lab/labPanelService.js', () => ({
  recordLabPanel: recordLabPanelMock,
  getLabPanel: getLabPanelMock,
  listPatientPanels: jest.fn(async () => []),
  getAnalyteTrend: jest.fn(async () => []),
  listReferenceRanges: jest.fn(async () => []),
  upsertReferenceRange: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // The router now carries a per-route patient guard, whose accessDecision /
  // careTeamEnforcement chain imports more of this module. An ESM mock factory
  // must provide EVERY export the graph imports or the suite fails to LOAD,
  // which reads like a missing test rather than a missing mock line.
  requireTenantId: (tenantId) => tenantId,
  // null falls back to the env/default posture, which is 'shadow'.
  getTenantById: async () => null,
}));

jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  claimIdempotencyKey: claimIdempotencyKeyMock,
  finaliseIdempotencyKey: finaliseIdempotencyKeyMock,
  hashRequestBody: () => 'a'.repeat(64),
  isValidIdempotencyKey: () => true,
  releaseIdempotencyKey: jest.fn(),
}));

const { default: labPanelRoutes } = await import('../../routes/lab/labPanelRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: req.get('x-test-role') || 'LAB_STAFF',
  };
  next();
});
app.use('/api/v1/lab', labPanelRoutes);

beforeEach(() => {
  recordLabPanelMock.mockReset();
  getLabPanelMock.mockReset();
  claimIdempotencyKeyMock.mockReset();
  finaliseIdempotencyKeyMock.mockReset();
  claimIdempotencyKeyMock.mockResolvedValue({ state: 'claimed', id: 91 });
  finaliseIdempotencyKeyMock.mockResolvedValue({ id: 91, status: 'failed' });
});

describe('lab panel route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    recordLabPanelMock.mockRejectedValueOnce(AppError.conflict(
      'A result for this panel has already been finalised',
      'LAB_PANEL_ALREADY_FINALISED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/lab/panels')
      .set('Idempotency-Key', 'lab-panel-route-test')
      .send({
        panelCode: 'CBC',
        patientUid: '22222222-2222-4222-8222-222222222222',
        investigationId: 17,
        analytes: [{ test_code: 'HGB', test_name: 'Hemoglobin', value_numeric: 13.2 }],
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('LAB_PANEL_ALREADY_FINALISED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(recordLabPanelMock).toHaveBeenCalledWith(expect.objectContaining({
      performedByUid: '11111111-1111-4111-8111-111111111111',
      performedByRole: 'LAB_STAFF',
      idempotencyKey: 'lab-panel-route-test',
      requestBodySha256: 'a'.repeat(64),
      httpIdempotencyClaimId: 91,
      requestId: 'test-request-id',
    }));
    expect(claimIdempotencyKeyMock).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000001',
      userUid: '11111111-1111-4111-8111-111111111111',
      requestKey: 'lab-panel-route-test',
      requestMethod: 'POST',
      requestPath: '/api/v1/lab/panels',
      requestBodyHash: 'a'.repeat(64),
    });
  });

  test('requires an idempotency key before invoking the clinical write', async () => {
    const response = await request(app)
      .post('/api/v1/lab/panels')
      .send({
        panelCode: 'CBC',
        patientUid: '22222222-2222-4222-8222-222222222222',
        investigationId: 17,
        analytes: [{ test_code: 'HGB', test_name: 'Hemoglobin', value_numeric: 13.2 }],
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key/i);
    expect(recordLabPanelMock).not.toHaveBeenCalled();
  });

  test.each(['DOCTOR', 'NURSING_STAFF'])('%s cannot author a manual lab panel', async (role) => {
    const response = await request(app)
      .post('/api/v1/lab/panels')
      .set('x-test-role', role)
      .set('Idempotency-Key', `lab-panel-role-${role}`)
      .send({
        panelCode: 'CBC',
        patientUid: '22222222-2222-4222-8222-222222222222',
        investigationId: 17,
        analytes: [{ test_code: 'HGB', test_name: 'Hemoglobin', value_numeric: 13.2 }],
      });

    expect(response.statusCode).toBe(403);
    expect(recordLabPanelMock).not.toHaveBeenCalled();
    expect(claimIdempotencyKeyMock).not.toHaveBeenCalled();
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The exact class of leak the original catch was hand-written to stop:
    // a stale Prisma client surfacing driver internals to the client.
    getLabPanelMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'findMany')"),
    );

    const response = await request(app)
      .get('/api/v1/lab/panels/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Lab panel error');
    expect(response.body.message).not.toMatch(/findMany/);
  });
});
