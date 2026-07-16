import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// nursingAssessmentRoutes.js wraps every handler in a local `wrap()` whose
// catch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg (dropping `err.code` + `err.details`) and relayed raw `err.message`
// on the generic-500 branch (`err.message || 'Assessment error'`). The port
// delegates to responseHelper.relayAppError, keeping the generic message and
// hardening the 500 branch to generic-only. These tests drive the endpoints
// over HTTP (supertest) and assert the response body itself.

const recordAssessmentMock = jest.fn();
const listForPatientMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/nursingAssessmentService.js', () => ({
  score: jest.fn(),
  recordAssessment: recordAssessmentMock,
  listForPatient: listForPatientMock,
  listOverdueOrHighRisk: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: nursingAssessmentRoutes } = await import('../../routes/clinical/nursingAssessmentRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/nursing-assessments', nursingAssessmentRoutes);

beforeEach(() => {
  recordAssessmentMock.mockReset();
  listForPatientMock.mockReset();
});

describe('nursing-assessment route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    recordAssessmentMock.mockRejectedValueOnce(AppError.conflict(
      'An assessment of this kind is already recorded for this window',
      'NURSING_ASSESSMENT_ALREADY_RECORDED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/nursing-assessments')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', kind: 'NEWS2' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An assessment of this kind is already recorded for this window');
    expect(response.body.code).toBe('NURSING_ASSESSMENT_ALREADY_RECORDED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Assessment error'` — the port
    // hardens this to generic-only (raw messages leak on non-prod deploys).
    listForPatientMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'braden_score')"),
    );

    const response = await request(app)
      .get('/api/v1/nursing-assessments/patient/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Assessment error');
    expect(response.body.message).not.toMatch(/braden_score/);
  });
});
