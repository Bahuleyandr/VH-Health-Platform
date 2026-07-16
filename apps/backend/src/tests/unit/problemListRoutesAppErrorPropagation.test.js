import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for problemListRoutes.js — relay-variants
// port of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const createProblemMock = jest.fn();
const getProblemMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/problemListService.js', () => ({
  listProblems: jest.fn(),
  getProblem: getProblemMock,
  createProblem: createProblemMock,
  updateProblem: jest.fn(),
  promoteDiagnosis: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_CLINICAL_WORKFLOW_ACCESS: 'PATIENT_CLINICAL_WORKFLOW_ACCESS',
    PATIENT_CLINICAL_WORKFLOW_WRITE: 'PATIENT_CLINICAL_WORKFLOW_WRITE',
  },
}));

const { default: problemListRoutes } = await import('../../routes/clinical/problemListRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  // DOCTOR passes the canEditProblems() gates.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/problems', problemListRoutes);

beforeEach(() => {
  createProblemMock.mockReset();
  getProblemMock.mockReset();
});

describe('problem list handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    createProblemMock.mockRejectedValueOnce(
      AppError.conflict('An active problem with this coding already exists', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/problems')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', title: 'Type 2 diabetes mellitus' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    getProblemMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'icd10_code')"),
    );

    const response = await request(app).get('/api/v1/problems/5');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to fetch problem');
    expect(response.body.message).not.toMatch(/icd10_code/);
  });
});
