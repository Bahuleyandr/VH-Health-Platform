import { readFileSync } from 'node:fs';

import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const listEvidence = jest.fn();

jest.unstable_mockModule(
  '../../services/pathways/pathwayReconciliationReadService.js',
  () => ({ listPathwayReconciliationEvidence: listEvidence }),
);

const { default: router } = await import('../../routes/admin/carePathwayReconciliationRoutes.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000001';

function app() {
  const instance = express();
  instance.use((req, _res, next) => {
    req.user = { role: req.get('x-test-role') || 'ADMIN' };
    req.tenantId = req.user.role === 'SUPER_ADMIN' && req.get('x-tenant-id')
      ? req.get('x-tenant-id')
      : TENANT_ID;
    next();
  });
  instance.use('/api/v1/admin/care-pathways/reconciliation', router);
  instance.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ code: error.code || 'ERROR' });
  });
  return instance;
}

describe('care pathway reconciliation admin routes', () => {
  beforeEach(() => {
    listEvidence.mockReset();
    listEvidence.mockResolvedValue({ evidence: [], count: 0, limit: 50, offset: 0 });
  });

  test('tenant-scopes ordinary ADMIN latest reads', async () => {
    const response = await request(app())
      .get('/api/v1/admin/care-pathways/reconciliation')
      .query({ pathway_key: 'diagnostics_order_to_action', limit: 10, offset: 2 });
    expect(response.status).toBe(200);
    expect(listEvidence).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      pathwayKey: 'diagnostics_order_to_action',
      view: 'latest',
      limit: '10',
      offset: '2',
    });
  });

  test('uses only the audited SUPER_ADMIN header context for cross-tenant history', async () => {
    const response = await request(app())
      .get('/api/v1/admin/care-pathways/reconciliation/history')
      .set('x-test-role', 'SUPER_ADMIN')
      .set('x-tenant-id', OTHER_TENANT_ID)
      .set('x-tenant-override-reason', 'Investigating reconciliation evidence');
    expect(response.status).toBe(200);
    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OTHER_TENANT_ID,
      view: 'history',
    }));
  });

  test('rejects tenant query parameters, ordinary-admin override headers, and non-admin roles', async () => {
    const queryTenant = await request(app())
      .get('/api/v1/admin/care-pathways/reconciliation')
      .query({ tenant_id: OTHER_TENANT_ID });
    expect(queryTenant.status).toBe(400);
    expect(queryTenant.body.code).toBe('PATHWAY_RECONCILIATION_TENANT_QUERY_FORBIDDEN');

    const headerOverride = await request(app())
      .get('/api/v1/admin/care-pathways/reconciliation')
      .set('x-tenant-id', OTHER_TENANT_ID);
    expect(headerOverride.status).toBe(403);

    const clinician = await request(app())
      .get('/api/v1/admin/care-pathways/reconciliation')
      .set('x-test-role', 'DOCTOR');
    expect(clinician.status).toBe(403);
    expect(listEvidence).not.toHaveBeenCalled();
  });

  test('exposes GET only and no recovery or activation handler', () => {
    const source = readFileSync(
      new URL('../../routes/admin/carePathwayReconciliationRoutes.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("router.get('/'");
    expect(source).toContain("router.get('/history'");
    expect(source).not.toMatch(/router\.(post|put|patch|delete)\(/);
    expect(source).not.toContain('createPathwayActivationCapability');
  });
});
