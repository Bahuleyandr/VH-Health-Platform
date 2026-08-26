import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// pcpndtRoutes.js is a statutory-compliance surface (PC-PNDT Act Form F /
// monthly submissions), so the relayAppError port deliberately changed
// nothing but the catch body + import. This suite pins that the wrap()
// relays a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md) and that the
// old 500 branch's raw `err.message` relay (`err.message || 'PCPNDT
// error'`) is hardened to the generic message only — a compliance surface
// must never leak driver internals to clients.

const createFormFMock = jest.fn();
const listFormFMock = jest.fn();

jest.unstable_mockModule('../../services/compliance/pcpndtService.js', () => ({
  listMachines: jest.fn(async () => []),
  upsertMachine: jest.fn(async () => ({})),
  listSonologists: jest.fn(async () => []),
  upsertSonologist: jest.fn(async () => ({})),
  createFormF: createFormFMock,
  listFormF: listFormFMock,
  getFormF: jest.fn(async () => ({})),
  generateMonthlySubmission: jest.fn(async () => ({})),
  listSubmissions: jest.fn(async () => []),
  acknowledgeSubmission: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Re-audit 2026-08 (M: mount guards): the router now carries per-route
// patientAccessGuard middleware. This suite pins the route layer's own
// contract, not authz — stub the guard factory to a pass-through so the real
// accessDecisionService import graph (and its DB reads) stays out of scope.
// Guard wiring + selectors are pinned by pcpndtRoutesPatientGuard.test.js.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

const { default: pcpndtRoutes } = await import('../../routes/compliance/pcpndtRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'RADIOLOGIST' };
  next();
});
app.use('/api/v1/pcpndt', pcpndtRoutes);

beforeEach(() => {
  createFormFMock.mockReset();
  listFormFMock.mockReset();
});

describe('PC-PNDT route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    createFormFMock.mockRejectedValueOnce(AppError.conflict(
      'A Form F already exists for this scan',
      'PCPNDT_FORM_F_DUPLICATE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/pcpndt/form-f')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        machine_id: 3,
        sonologist_id: 5,
        indication: 'anomaly scan',
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PCPNDT_FORM_F_DUPLICATE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'PCPNDT error'` — this pins the
    // hardened generic-only behaviour.
    listFormFMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'pcpndt_form_f')"),
    );

    const response = await request(app).get('/api/v1/pcpndt/form-f');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('PCPNDT error');
    expect(response.body.message).not.toMatch(/pcpndt_form_f/);
  });
});
