// src/tests/unit/labCodeMappingRoutes.test.js
//
// Terminology WP3 — /api/v1/lab/code-mappings route contract: staff/admin
// reads, terminology-curator writes, coverage routing ahead of /:id, and
// AppError relay. Service layer fully mocked.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Keep the real route module graph (tenantService, terminologyRoutes for the
// curator role list) loadable without a generated Prisma client.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn(), $transaction: jest.fn(),
  },
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

const listMappings = jest.fn();
const getMapping = jest.fn();
const createMapping = jest.fn();
const updateMapping = jest.fn();
const deactivateMapping = jest.fn();
const coverageReport = jest.fn();

jest.unstable_mockModule('../../services/lab/labCodeMappingService.js', () => ({
  listMappings,
  getMapping,
  createMapping,
  updateMapping,
  deactivateMapping,
  coverageReport,
}));

const { default: labCodeMappingRoutes } = await import('../../routes/lab/labCodeMappingRoutes.js');

const TENANT = '11111111-2222-4333-8444-555555555555';
let currentUser;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = currentUser;
  req.tenantId = TENANT;
  next();
});
app.use('/api/v1/lab/code-mappings', labCodeMappingRoutes);

beforeEach(() => {
  for (const fn of [listMappings, getMapping, createMapping, updateMapping, deactivateMapping, coverageReport]) {
    fn.mockReset();
  }
  currentUser = { uid: 'actor-uid', role: 'LAB_STAFF' };
});

describe('reads (staff or admin)', () => {
  it('lists mappings with the resolved tenant and filters', async () => {
    currentUser = { uid: 'doc-uid', role: 'DOCTOR' };
    listMappings.mockResolvedValueOnce({ mappings: [], count: 0 });
    const res = await request(app)
      .get('/api/v1/lab/code-mappings?source_key=SYSMEX-1&q=K&include_inactive=true');
    expect(res.status).toBe(200);
    expect(listMappings).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      sourceKey: 'SYSMEX-1',
      q: 'K',
      includeInactive: true,
    }));
  });

  it('rejects a patient read', async () => {
    currentUser = { uid: 'patient-uid', role: 'PATIENT' };
    const res = await request(app).get('/api/v1/lab/code-mappings');
    expect(res.status).toBe(403);
    expect(listMappings).not.toHaveBeenCalled();
  });

  it('routes /coverage to the coverage report, not the id handler', async () => {
    coverageReport.mockResolvedValueOnce({ window_days: 30 });
    const res = await request(app).get('/api/v1/lab/code-mappings/coverage?days=14');
    expect(res.status).toBe(200);
    expect(coverageReport).toHaveBeenCalledWith({ tenantId: TENANT, days: '14' });
    expect(getMapping).not.toHaveBeenCalled();
  });

  it('fetches one mapping by id', async () => {
    getMapping.mockResolvedValueOnce({ id: 7 });
    const res = await request(app).get('/api/v1/lab/code-mappings/7');
    expect(res.status).toBe(200);
    expect(getMapping).toHaveBeenCalledWith({ tenantId: TENANT, id: '7' });
  });
});

describe('writes (terminology curators only)', () => {
  it('lets a lab curator create a mapping', async () => {
    createMapping.mockResolvedValueOnce({ id: 7 });
    const res = await request(app)
      .post('/api/v1/lab/code-mappings')
      .send({ incoming_code: 'K', loinc_code: '2823-3' });
    expect(res.status).toBe(200);
    expect(createMapping).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorUid: 'actor-uid',
      mapping: { incoming_code: 'K', loinc_code: '2823-3' },
    });
  });

  it('rejects a non-curator clinician write', async () => {
    currentUser = { uid: 'doc-uid', role: 'DOCTOR' };
    const res = await request(app)
      .post('/api/v1/lab/code-mappings')
      .send({ incoming_code: 'K', loinc_code: '2823-3' });
    expect(res.status).toBe(403);
    expect(createMapping).not.toHaveBeenCalled();
  });

  it('lets an admin update and delete (deactivate)', async () => {
    currentUser = { uid: 'admin-uid', role: 'ADMIN' };
    updateMapping.mockResolvedValueOnce({ id: 7 });
    deactivateMapping.mockResolvedValueOnce({ id: 7, active: false });

    const putRes = await request(app)
      .put('/api/v1/lab/code-mappings/7')
      .send({ display: 'Potassium' });
    expect(putRes.status).toBe(200);
    expect(updateMapping).toHaveBeenCalledWith({
      tenantId: TENANT, id: '7', actorUid: 'admin-uid', patch: { display: 'Potassium' },
    });

    const delRes = await request(app).delete('/api/v1/lab/code-mappings/7');
    expect(delRes.status).toBe(200);
    expect(deactivateMapping).toHaveBeenCalledWith({
      tenantId: TENANT, id: '7', actorUid: 'admin-uid',
    });
  });
});

describe('error relay', () => {
  it('relays AppError status + code from the service', async () => {
    createMapping.mockRejectedValueOnce(AppError.conflict(
      'An active mapping for this source and incoming code already exists',
      'LAB_CODE_MAPPING_DUPLICATE',
    ));
    const res = await request(app)
      .post('/api/v1/lab/code-mappings')
      .send({ incoming_code: 'K', loinc_code: '2823-3' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAB_CODE_MAPPING_DUPLICATE');
  });

  it('hardens unexpected failures to the generic 500 message', async () => {
    coverageReport.mockRejectedValueOnce(new Error('secret internals'));
    const res = await request(app).get('/api/v1/lab/code-mappings/coverage');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Lab code mapping error');
  });
});
