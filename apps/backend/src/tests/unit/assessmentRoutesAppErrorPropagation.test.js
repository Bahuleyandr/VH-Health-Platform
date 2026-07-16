import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port (wrap-sweep).
//
// assessmentRoutes.js has one INLINE catch site — the pure-compute
// GET /growth/percentile handler (every other handler forwards to next()).
// It used to call `error(res, err.message, err.statusCode)` with no 4th arg
// (dropping `err.code` + `err.details`) and, worse, relayed raw
// `err.message` on the generic-500 branch. The port delegates the whole
// catch to responseHelper.relayAppError with this handler's own generic
// message ('Compute failed'); these tests drive the endpoint over HTTP
// (supertest) and assert the response body itself.

const computePercentileMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/growthPercentileService.js', () => ({
  computePercentile: computePercentileMock,
}));

jest.unstable_mockModule('../../services/clinical/clinicalAssessmentService.js', () => ({
  listFallRiskAssessments: jest.fn(async () => []),
  listGrowthCharts: jest.fn(async () => []),
  listPainAssessments: jest.fn(async () => []),
  recordFallRiskAssessment: jest.fn(),
  recordGrowthChart: jest.fn(),
  recordPainAssessment: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_CLINICAL_WORKFLOW_ACCESS: 'PATIENT_CLINICAL_WORKFLOW_ACCESS',
    PATIENT_CLINICAL_WORKFLOW_WRITE: 'PATIENT_CLINICAL_WORKFLOW_WRITE',
  },
}));

const { default: assessmentRoutes } = await import('../../routes/clinical/assessmentRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/clinical/assessments', assessmentRoutes);

beforeEach(() => {
  computePercentileMock.mockReset();
});

describe('assessment /growth/percentile inline catch surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    computePercentileMock.mockRejectedValueOnce(AppError.conflict(
      'Growth reference dataset revision changed while computing',
      'GROWTH_REFERENCE_REVISION_CONFLICT',
      { reason: 'x' },
    ));

    const response = await request(app)
      .get('/api/v1/clinical/assessments/growth/percentile')
      .query({ sex: 'M', ageInDays: 120, metric: 'weight_kg', value: 6.1 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Growth reference dataset revision changed while computing');
    expect(response.body.code).toBe('GROWTH_REFERENCE_REVISION_CONFLICT');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old branch relayed `err.message || 'Compute failed'` — the port
    // hardens this to generic-only (raw messages leak on non-prod deploys).
    computePercentileMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'lmsTable')"),
    );

    const response = await request(app)
      .get('/api/v1/clinical/assessments/growth/percentile')
      .query({ sex: 'F', ageInDays: 30, metric: 'height_cm', value: 52 });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Compute failed');
    expect(response.body.message).not.toMatch(/lmsTable/);
  });
});
