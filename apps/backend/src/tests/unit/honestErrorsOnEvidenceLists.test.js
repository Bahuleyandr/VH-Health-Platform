// src/tests/unit/honestErrorsOnEvidenceLists.test.js
//
// F5 (2026-08-10 audit, fake-success residue): GET /gdpr/erasure-log and the
// admin device list caught ANY database error and returned HTTP 200 with an
// empty array — a compliance officer pulling DPDP/GDPR erasure evidence during
// a DB fault was shown "no erasures" as if it were authoritative. Contract now
// pinned by this suite:
//
//   * a real database error returns a real 5xx error envelope;
//   * ONLY a verified missing-table condition for the exact optional relation
//     (SQLSTATE 42P01 outside production, per schemaMissingGuard) returns the
//     honest empty result — and then with an explicit `meta.table_missing`
//     caveat, never a silent empty list;
//   * message-text matching ("does not exist") is NOT enough to soften a
//     failure into an empty success.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ADMIN_UID = '44444444-4444-4444-8444-444444444444';

const queryRawUnsafe = jest.fn();
const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// gdprRoutes collaborators
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: () => (_req, _res, next) => next(),
  default: { requireRole: () => (_req, _res, next) => next() },
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  deriveTenantIdFromRequest: () => TENANT,
}));
jest.unstable_mockModule('../../services/gdpr/dataErasureService.js', () => ({
  executeErasure: jest.fn(),
  checkLegalHold: jest.fn(),
}));

// deviceRoutes collaborators
jest.unstable_mockModule('../../middleware/jwtMiddleware.js', () => ({
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/validateApiKey.js', () => ({
  default: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../controllers/deviceController.js', () => ({
  registerDevice: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
}));
// Register routes directly — RBAC wiring is not under test here, the
// handler catch-block contract is.
jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAsync: (fn) => fn,
  wrapAutoRBAC: (router, _configKey, routeMap) => {
    for (const [method, routes] of Object.entries(routeMap)) {
      for (const [path, ...handlers] of routes) router[method](path, ...handlers);
    }
    return router;
  },
}));

const { default: gdprRoutes } = await import('../../routes/gdprRoutes.js');
const { default: deviceRoutes } = await import('../../routes/deviceRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: ADMIN_UID, role: 'ADMIN', phone: '+919999900000' };
  next();
});
app.use('/api/v1/gdpr', gdprRoutes);
app.use('/api/v1/devices', deviceRoutes);

function missingTableError(tableName) {
  const err = new Error(`relation "${tableName}" does not exist`);
  err.meta = { code: '42P01' };
  return err;
}

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

describe('GET /gdpr/erasure-log', () => {
  it('returns rows normally when the query succeeds', async () => {
    const row = { id: 1, uid: ADMIN_UID, reason: 'dpdp request' };
    queryRawUnsafe.mockResolvedValueOnce([row]);

    const response = await request(app).get('/api/v1/gdpr/erasure-log');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([row]);
    expect(response.body.meta).toBeUndefined();
  });

  it('returns a 500 error on a generic DB fault — never an empty 200', async () => {
    queryRawUnsafe.mockRejectedValueOnce(new Error('Circuit breaker open'));

    const response = await request(app).get('/api/v1/gdpr/erasure-log');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });

  it('a "does not exist" message WITHOUT the 42P01 code is still a 500', async () => {
    // The exact hole schemaMissingGuard closed for the access guards: message
    // regexes also match "operator does not exist", renamed columns, etc.
    queryRawUnsafe.mockRejectedValueOnce(new Error('column "uid" does not exist'));

    const response = await request(app).get('/api/v1/gdpr/erasure-log');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
  });

  it('an exact missing gdpr_erasure_log returns an explicit non-production caveat', async () => {
    queryRawUnsafe.mockRejectedValueOnce(missingTableError('gdpr_erasure_log'));

    const response = await request(app).get('/api/v1/gdpr/erasure-log');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta).toEqual({ table_missing: true });
    expect(response.body.message).toMatch(/does not exist yet/);
  });

  it('a 42P01 for another relation fails loudly', async () => {
    queryRawUnsafe.mockRejectedValueOnce(missingTableError('users'));

    const response = await request(app).get('/api/v1/gdpr/erasure-log');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });
});

describe('GET /devices/admin/list', () => {
  it('returns devices normally when the query succeeds', async () => {
    const device = { id: 7, device_id: 'dev-1', user_id: ADMIN_UID };
    queryRawUnsafe.mockResolvedValueOnce([device]);

    const response = await request(app).get('/api/v1/devices/admin/list');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([device]);
    expect(response.body.meta).toBeUndefined();
  });

  it('returns a 500 error on a generic DB fault — never an empty 200', async () => {
    queryRawUnsafe.mockRejectedValueOnce(new Error('Circuit breaker open'));

    const response = await request(app).get('/api/v1/devices/admin/list');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });

  it('an exact missing user_devices table returns an explicit non-production caveat', async () => {
    queryRawUnsafe.mockRejectedValueOnce(missingTableError('user_devices'));

    const response = await request(app).get('/api/v1/devices/admin/list');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta).toEqual({ table_missing: true });
  });

  it('a 42P01 for the joined users relation fails loudly', async () => {
    queryRawUnsafe.mockRejectedValueOnce(missingTableError('users'));

    const response = await request(app).get('/api/v1/devices/admin/list');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });

  it('still refuses non-admin users', async () => {
    const nonAdminApp = express();
    nonAdminApp.use((req, _res, next) => {
      req.user = { uid: ADMIN_UID, role: 'NURSE' };
      next();
    });
    nonAdminApp.use('/api/v1/devices', deviceRoutes);

    const response = await request(nonAdminApp).get('/api/v1/devices/admin/list');

    expect(response.statusCode).toBe(403);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('GET /devices/my-devices', () => {
  const currentUser = {
    uid: ADMIN_UID,
    phone: '+919999900000',
    name: 'Admin One',
    tenant_id: TENANT,
  };

  it('returns the caller devices when both identity and device queries succeed', async () => {
    const device = {
      device_id: 'self-device',
      device_name: 'Ward tablet',
      status: 'active',
      fcm_token: 'test-fcm-token',
    };
    queryRawUnsafe
      .mockResolvedValueOnce([currentUser])
      .mockResolvedValueOnce([device]);

    const response = await request(app).get('/api/v1/devices/my-devices');

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      devices: [device],
      totalDevices: 1,
      activeDevices: 1,
    });
  });

  it('returns a 500 error on an identity-query DB fault — never an empty authoritative device list', async () => {
    queryRawUnsafe.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const response = await request(app).get('/api/v1/devices/my-devices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });

  it('returns a 500 error on a generic device query fault — never an empty 200', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([currentUser])
      .mockRejectedValueOnce(new Error('Circuit breaker open'));

    const response = await request(app).get('/api/v1/devices/my-devices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });

  it('a missing users relation fails loudly instead of masquerading as no devices', async () => {
    queryRawUnsafe.mockRejectedValueOnce(missingTableError('users'));

    const response = await request(app).get('/api/v1/devices/my-devices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
  });
  it('returns 500 when the baseline-required user_devices table is missing', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([currentUser])
      .mockRejectedValueOnce(missingTableError('user_devices'));

    const response = await request(app).get('/api/v1/devices/my-devices');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.data).toBeUndefined();
  });
});
