import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// terminology handleFailure (previously `err.details ?? { code: err.code }`).

const listCodeSystemsMock = jest.fn();

jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  listCodeSystems: listCodeSystemsMock,
  searchConcepts: jest.fn(),
  getConcept: jest.fn(),
  validateCode: jest.fn(),
  mapCode: jest.fn(),
  upsertConceptMap: jest.fn(),
  bindCatalogItem: jest.fn(),
  listCatalogBindings: jest.fn(),
  suggestCatalogBindings: jest.fn(),
  coverageReport: jest.fn(),
}));

jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  getTenantTerminologySettings: jest.fn(),
  setTenantTerminologySettings: jest.fn(),
}));

const { default: terminologyRoutes } = await import('../../routes/terminology/terminologyRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/terminology', terminologyRoutes);

beforeEach(() => {
  listCodeSystemsMock.mockReset();
});

describe('terminology handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listCodeSystemsMock.mockRejectedValueOnce(AppError.conflict(
      'Code system release import is in progress',
      'TERMINOLOGY_IMPORT_IN_PROGRESS',
      { system: 'ICD10' },
    ));

    const response = await request(app).get('/api/v1/terminology/code-systems');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('TERMINOLOGY_IMPORT_IN_PROGRESS');
    expect(response.body.details).toEqual({ system: 'ICD10' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listCodeSystemsMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/terminology/code-systems');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list code systems');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
