import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// research handleFailure (previously `err.details ?? { code: err.code }`).

const listRegistriesMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
}));

jest.unstable_mockModule('../../services/research/researchRegistryService.js', () => ({
  createRegistry: jest.fn(),
  listRegistries: listRegistriesMock,
  createCrfForm: jest.fn(),
  publishCrfForm: jest.fn(),
  listForms: jest.fn(),
  enrollPatient: jest.fn(),
  withdrawEnrollment: jest.fn(),
  listEnrollments: jest.fn(),
  captureCrfResponse: jest.fn(),
  submitCrfResponse: jest.fn(),
  verifyCrfResponse: jest.fn(),
  exportRegistry: jest.fn(),
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  deriveTenantIdFromRequest: () => '00000000-0000-4000-8000-000000000001',
  patientAccessErrorPayload: () => ({ success: false, message: 'denied' }),
}));

const { default: researchRoutes } = await import('../../routes/research/researchRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/research', researchRoutes);

beforeEach(() => {
  listRegistriesMock.mockReset();
});

describe('research handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listRegistriesMock.mockRejectedValueOnce(AppError.conflict(
      'Registry code already exists',
      'RESEARCH_REGISTRY_DUPLICATE',
      { code: 'ONCO-01' },
    ));

    const response = await request(app).get('/api/v1/research/registries');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('RESEARCH_REGISTRY_DUPLICATE');
    expect(response.body.details).toEqual({ code: 'ONCO-01' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listRegistriesMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/research/registries');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list registries');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
