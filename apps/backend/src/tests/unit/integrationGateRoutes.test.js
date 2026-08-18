// src/tests/unit/integrationGateRoutes.test.js
//
// The SUPER_ADMIN-only Integrations & Gates console read, mounted at
// /api/v1/admin/integration-gates. This suite covers the router's own
// contract with the REAL requireRole middleware: the role gate, the
// tenantId validation, and the error shape.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const listIntegrationGates = jest.fn();

jest.unstable_mockModule('../../services/integrations/integrationGateService.js', () => ({
  listIntegrationGates,
  default: { listIntegrationGates },
}));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
  SecurityEvents: {},
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/admin/integrationGateRoutes.js');

function app(role) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role, scope: 'full' };
    next();
  });
  instance.use('/api/v1/admin/integration-gates', router);
  return instance;
}

const REPORT = {
  generated_at: '2026-08-18T00:00:00.000Z',
  env: { payment_gateway_enabled: false },
  tenants: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  listIntegrationGates.mockResolvedValue(REPORT);
});

describe('role gate', () => {
  it('403s a plain ADMIN (SUPER_ADMIN-only console)', async () => {
    const res = await request(app('ADMIN')).get('/api/v1/admin/integration-gates');
    expect(res.status).toBe(403);
    expect(listIntegrationGates).not.toHaveBeenCalled();
  });

  it.each(['DOCTOR', 'HR_MANAGER', 'PATIENT'])('403s role %s', async (role) => {
    const res = await request(app(role)).get('/api/v1/admin/integration-gates');
    expect(res.status).toBe(403);
    expect(listIntegrationGates).not.toHaveBeenCalled();
  });

  it('200s a SUPER_ADMIN and returns the service report', async () => {
    const res = await request(app('SUPER_ADMIN')).get('/api/v1/admin/integration-gates');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(REPORT);
    expect(listIntegrationGates).toHaveBeenCalledWith({ tenantId: null, limit: undefined });
  });
});

describe('query handling', () => {
  it('passes a valid tenantId filter through (lowercased)', async () => {
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const res = await request(app('SUPER_ADMIN'))
      .get(`/api/v1/admin/integration-gates?tenantId=${tenantId.toUpperCase()}&limit=5`);
    expect(res.status).toBe(200);
    expect(listIntegrationGates).toHaveBeenCalledWith({ tenantId, limit: '5' });
  });

  it('400s a non-UUID tenantId without touching the service', async () => {
    const res = await request(app('SUPER_ADMIN'))
      .get('/api/v1/admin/integration-gates?tenantId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(listIntegrationGates).not.toHaveBeenCalled();
  });

  it('500s with a generic message on service failure (no err.message leak)', async () => {
    listIntegrationGates.mockRejectedValue(new Error('SELECT * FROM secrets failed'));
    const res = await request(app('SUPER_ADMIN')).get('/api/v1/admin/integration-gates');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secrets failed');
  });
});
