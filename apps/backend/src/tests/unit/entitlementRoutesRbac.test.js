// src/tests/unit/entitlementRoutesRbac.test.js
//
// #883 gave PUT /admin/entitlements/tenants/:tenantId requireRole('SUPER_ADMIN')
// but left the two tenant-scoped GETs open to any ADMIN-route role. This
// suite pins the symmetric gate: cross-tenant entitlement reads (summary +
// audit) are SUPER_ADMIN-only, while /current and /catalog stay
// ADMIN-readable. Uses the REAL requireRole middleware.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const getEntitlementCatalog = jest.fn();
const getTenantEntitlementSummary = jest.fn();
const listEntitlementAuditEvents = jest.fn();
const upsertTenantEntitlement = jest.fn();

jest.unstable_mockModule('../../services/entitlements/entitlementService.js', () => ({
  getEntitlementCatalog,
  getTenantEntitlementSummary,
  listEntitlementAuditEvents,
  upsertTenantEntitlement,
}));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/admin/entitlementRoutes.js');

const TENANT_ID = '55555555-5555-4555-8555-555555555555';

function app(role) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role, scope: 'full' };
    req.tenantId = '66666666-6666-4666-8666-666666666666';
    next();
  });
  instance.use('/api/v1/admin/entitlements', router);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  getEntitlementCatalog.mockResolvedValue({ packages: [], features: [] });
  getTenantEntitlementSummary.mockResolvedValue({ tenantId: TENANT_ID, packages: [] });
  listEntitlementAuditEvents.mockResolvedValue([]);
});

describe('cross-tenant GETs are SUPER_ADMIN-only (symmetric with the #883 PUT gate)', () => {
  it('403s an ADMIN on GET /tenants/:tenantId', async () => {
    const res = await request(app('ADMIN'))
      .get(`/api/v1/admin/entitlements/tenants/${TENANT_ID}`);
    expect(res.status).toBe(403);
    expect(getTenantEntitlementSummary).not.toHaveBeenCalled();
  });

  it('403s an ADMIN on GET /tenants/:tenantId/audit', async () => {
    const res = await request(app('ADMIN'))
      .get(`/api/v1/admin/entitlements/tenants/${TENANT_ID}/audit`);
    expect(res.status).toBe(403);
    expect(listEntitlementAuditEvents).not.toHaveBeenCalled();
  });

  it('200s a SUPER_ADMIN on both tenant-scoped GETs', async () => {
    const summary = await request(app('SUPER_ADMIN'))
      .get(`/api/v1/admin/entitlements/tenants/${TENANT_ID}`);
    expect(summary.status).toBe(200);
    expect(getTenantEntitlementSummary).toHaveBeenCalledWith(TENANT_ID);

    const audit = await request(app('SUPER_ADMIN'))
      .get(`/api/v1/admin/entitlements/tenants/${TENANT_ID}/audit`);
    expect(audit.status).toBe(200);
    expect(listEntitlementAuditEvents).toHaveBeenCalledWith(TENANT_ID, { limit: undefined });
  });
});

describe('tenant-self reads stay ADMIN-readable', () => {
  it('200s an ADMIN on GET /current (own tenant from req.tenantId)', async () => {
    const res = await request(app('ADMIN')).get('/api/v1/admin/entitlements/current');
    expect(res.status).toBe(200);
    expect(getTenantEntitlementSummary)
      .toHaveBeenCalledWith('66666666-6666-4666-8666-666666666666');
  });

  it('200s an ADMIN on GET /catalog', async () => {
    const res = await request(app('ADMIN')).get('/api/v1/admin/entitlements/catalog');
    expect(res.status).toBe(200);
    expect(getEntitlementCatalog).toHaveBeenCalled();
  });
});

describe('the PUT gate is unchanged', () => {
  it('403s an ADMIN and never reaches the service', async () => {
    const res = await request(app('ADMIN'))
      .put(`/api/v1/admin/entitlements/tenants/${TENANT_ID}`)
      .send({ packageKey: 'core', status: 'active' });
    expect(res.status).toBe(403);
    expect(upsertTenantEntitlement).not.toHaveBeenCalled();
  });
});
