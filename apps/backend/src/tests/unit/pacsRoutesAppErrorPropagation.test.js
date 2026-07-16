import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port. pacsRoutes'
// shared handleFailure previously relayed AppErrors with `err.details ??
// { code: err.code }` (code buried under details) and hand-rolled the
// logged generic 500. relayAppError lifts err.code to the envelope root,
// nests err.details, and never relays a non-AppError message.

const buildModalityWorklistMock = jest.fn();

jest.unstable_mockModule('../../services/radiology/pacsService.js', () => ({
  getPacsConfig: jest.fn(() => ({})),
  linkStudy: jest.fn(),
  listPatientStudies: jest.fn(),
  buildModalityWorklist: buildModalityWorklistMock,
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

const { default: pacsRoutes } = await import('../../routes/radiology/pacsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/pacs', pacsRoutes);

beforeEach(() => {
  buildModalityWorklistMock.mockReset();
});

describe('PACS handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    buildModalityWorklistMock.mockRejectedValueOnce(AppError.conflict(
      'Worklist sidecar is already syncing',
      'PACS_WORKLIST_SYNC_IN_PROGRESS',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/pacs/worklist');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PACS_WORKLIST_SYNC_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('AppError without details produces root code and NO details key', async () => {
    buildModalityWorklistMock.mockRejectedValueOnce(new AppError(
      'Modality filter is invalid',
      422,
      'PACS_MODALITY_INVALID',
    ));

    const response = await request(app).get('/api/v1/pacs/worklist');

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('PACS_MODALITY_INVALID');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    buildModalityWorklistMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/pacs/worklist');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to build modality worklist');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
