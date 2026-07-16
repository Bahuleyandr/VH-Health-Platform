import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for physioRoutes.js — relay-variants port
// of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const listWorklistMock = jest.fn();
const createAssessmentMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/physioService.js', () => ({
  createAssessment: createAssessmentMock,
  createTherapyPlan: jest.fn(),
  getAdminProgress: jest.fn(),
  getOutcomeTrend: jest.fn(),
  getPatientSummary: jest.fn(),
  listWorklist: listWorklistMock,
  recordOutcomeScore: jest.fn(),
  recordSession: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: physioRoutes } = await import('../../routes/clinical/physioRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/physio', physioRoutes);

beforeEach(() => {
  listWorklistMock.mockReset();
  createAssessmentMock.mockReset();
});

describe('physio handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    createAssessmentMock.mockRejectedValueOnce(
      AppError.conflict('An open physio assessment already exists', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/physio/assessments')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listWorklistMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'care_plan_id')"),
    );

    const response = await request(app).get('/api/v1/physio/worklist');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to load physio worklist');
    expect(response.body.message).not.toMatch(/care_plan_id/);
  });
});
