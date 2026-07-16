import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for medRecRoutes.js — relay-variants port
// of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details` — the
// med-rec deep suite's `body.details.reconciliation_id` /
// `body.details.undecided` contracts must keep working.

const startReconciliationMock = jest.fn();
const getReconciliationMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/medicationReconciliationService.js', () => ({
  startReconciliation: startReconciliationMock,
  getReconciliation: getReconciliationMock,
  listReconciliations: jest.fn(),
  decideItem: jest.fn(),
  completeReconciliation: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_CLINICAL_WORKFLOW_ACCESS: 'PATIENT_CLINICAL_WORKFLOW_ACCESS',
    PATIENT_MEDICATION_RECONCILIATION_WRITE: 'PATIENT_MEDICATION_RECONCILIATION_WRITE',
  },
}));

const { default: medRecRoutes } = await import('../../routes/clinical/medRecRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  // DOCTOR passes the canDecide() gates.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/med-rec', medRecRoutes);

beforeEach(() => {
  startReconciliationMock.mockReset();
  getReconciliationMock.mockReset();
});

describe('med-rec handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    // Same shape the deep suite pins over HTTP: the in-progress-rec conflict
    // carries details.reconciliation_id for client dedupe.
    startReconciliationMock.mockRejectedValueOnce(
      AppError.conflict('A reconciliation of this type is already in progress', 'SOME_CODE', {
        reason: 'x',
        reconciliation_id: 7,
      }),
    );

    const response = await request(app)
      .post('/api/v1/med-rec/start')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', rec_type: 'admission' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x', reconciliation_id: 7 });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    getReconciliationMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'rec_items')"),
    );

    const response = await request(app).get('/api/v1/med-rec/5');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to fetch reconciliation');
    expect(response.body.message).not.toMatch(/rec_items/);
  });
});
