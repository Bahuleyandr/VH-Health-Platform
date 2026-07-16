import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// dialysisRoutes.js wraps every handler in a local `wrap()` whose catch used
// to call `error(res, err.message, err.statusCode)` with no 4th arg (dropping
// `err.code` + `err.details`) and relayed raw `err.message` on the
// generic-500 branch (`err.message || 'Dialysis error'`). The port delegates
// to responseHelper.relayAppError, keeping the generic message and hardening
// the 500 branch to generic-only. These tests drive the endpoints over HTTP
// (supertest) and assert the response body itself.

const enrolPatientMock = jest.fn();
const listPatientsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/dialysisService.js', () => ({
  enrolPatient: enrolPatientMock,
  listPatients: listPatientsMock,
}));

jest.unstable_mockModule('../../services/clinical/dialysisMachineService.js', () => ({
  ingestMachineObservations: jest.fn(),
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitDialysisEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: dialysisRoutes } = await import('../../routes/clinical/dialysisRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/dialysis', dialysisRoutes);

beforeEach(() => {
  enrolPatientMock.mockReset();
  listPatientsMock.mockReset();
});

describe('dialysis route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    enrolPatientMock.mockRejectedValueOnce(AppError.conflict(
      'Patient is already enrolled in the dialysis program',
      'DIALYSIS_PATIENT_ALREADY_ENROLLED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/dialysis/patients')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Patient is already enrolled in the dialysis program');
    expect(response.body.code).toBe('DIALYSIS_PATIENT_ALREADY_ENROLLED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Dialysis error'` — the port
    // hardens this to generic-only (raw messages leak on non-prod deploys).
    listPatientsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'dry_weight_kg')"),
    );

    const response = await request(app)
      .get('/api/v1/dialysis/patients');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Dialysis error');
    expect(response.body.message).not.toMatch(/dry_weight_kg/);
  });
});
