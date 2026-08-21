// WP1 — GET /terminology/search route contract: explicit `system` keeps the
// original single-system path byte-identical; absent/blank `system` routes to
// the settings-driven searchDiagnosisConcepts and additionally exposes
// `resolved`.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const searchConceptsMock = jest.fn();
const searchDiagnosisConceptsMock = jest.fn();

jest.unstable_mockModule('../../services/terminology/terminologyService.js', () => ({
  listCodeSystems: jest.fn(),
  searchConcepts: searchConceptsMock,
  searchDiagnosisConcepts: searchDiagnosisConceptsMock,
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

const TENANT = '00000000-0000-4000-8000-000000000001';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  req.tenantId = TENANT;
  next();
});
app.use('/api/v1/terminology', terminologyRoutes);

const CONCEPT = {
  system_key: 'ICD11',
  code: 'XZ90',
  display: 'Synthetic fabricated disorder alpha',
  category: null,
  semantic_tag: null,
  status: 'active',
  match_rank: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('explicit system param keeps the original single-system contract', async () => {
  searchConceptsMock.mockResolvedValueOnce([CONCEPT]);

  const res = await request(app).get('/api/v1/terminology/search?system=ICD11&q=synthetic&limit=5');

  expect(res.statusCode).toBe(200);
  expect(searchConceptsMock).toHaveBeenCalledWith({
    system: 'ICD11',
    q: 'synthetic',
    limit: '5',
    tenantId: TENANT,
  });
  expect(searchDiagnosisConceptsMock).not.toHaveBeenCalled();
  expect(res.body.data).toEqual({ concepts: [CONCEPT], count: 1 });
  expect(res.body.data.resolved).toBeUndefined();
});

test('no system param routes to the settings-driven search and returns resolved', async () => {
  searchDiagnosisConceptsMock.mockResolvedValueOnce({
    query: 'synthetic',
    resolved: { preferred_system: 'ICD11', systems: ['ICD11', 'ICD10'], snomed_included: false },
    concepts: [CONCEPT],
  });

  const res = await request(app).get('/api/v1/terminology/search?q=synthetic');

  expect(res.statusCode).toBe(200);
  expect(searchDiagnosisConceptsMock).toHaveBeenCalledWith({
    tenantId: TENANT,
    q: 'synthetic',
    limit: undefined,
  });
  expect(searchConceptsMock).not.toHaveBeenCalled();
  expect(res.body.data).toEqual({
    concepts: [CONCEPT],
    count: 1,
    resolved: { preferred_system: 'ICD11', systems: ['ICD11', 'ICD10'], snomed_included: false },
  });
});

test('blank system param is treated as absent', async () => {
  searchDiagnosisConceptsMock.mockResolvedValueOnce({
    query: 'synthetic',
    resolved: { preferred_system: 'ICD11', systems: ['ICD11'], snomed_included: false },
    concepts: [],
  });

  const res = await request(app).get('/api/v1/terminology/search?system=&q=synthetic');

  expect(res.statusCode).toBe(200);
  expect(searchDiagnosisConceptsMock).toHaveBeenCalledTimes(1);
  expect(res.body.data.concepts).toEqual([]);
  expect(res.body.data.count).toBe(0);
});
