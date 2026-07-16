import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — the audit-console member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// auditQueryController.js funnels the unified-audit handlers through a local
// auditError() whose operational branch called `error(res, err.message,
// err.statusCode, { code: err.code })` — the code arrived NESTED under
// details.code and any service-attached err.details were dropped. The branch
// now relays via relayAppError: code at the envelope root, details forwarded.
// The site's own predicate (`err?.isOperational && err?.statusCode`) and the
// operation-labelled generic tail are KEPT, and pinned below.
//
// Driven through the real router that mounts the controller
// (src/routes/admin/auditRoutes.js).

const listAuditEventsMock = jest.fn();
const getAuditEventDetailMock = jest.fn();

jest.unstable_mockModule('../../services/compliance/auditAccountabilityService.js', () => ({
  exportAuditEvents: jest.fn(async () => ({ csv: '', filters: {}, row_count: 0 })),
  getAuditEventDetail: getAuditEventDetailMock,
  getAuditHealth: jest.fn(async () => ({ window: {} })),
  listAuditEvents: listAuditEventsMock,
  recordAuditConsoleAccess: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));
// The controller imports the prisma singleton for the legacy raw-SQL
// handlers; stub it so the suite never touches a DB.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));

const { default: auditRoutes } = await import('../../routes/admin/auditRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'SUPER_ADMIN' };
  next();
});
app.use('/api/v1/admin/audit', auditRoutes);

beforeEach(() => {
  listAuditEventsMock.mockReset();
  getAuditEventDetailMock.mockReset();
});

describe('auditError operational branch surfaces AppError code + details', () => {
  test('GET /events — code arrives at the envelope ROOT (not details.code) and details forward', async () => {
    listAuditEventsMock.mockRejectedValueOnce(AppError.conflict(
      'Audit window is being re-indexed',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/admin/audit/events');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Audit window is being re-indexed');
    // Old wire shape nested the code (details.code) and dropped err.details;
    // the relay lifts code to the root and forwards details.
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('GET /events/:source/:id — a details-less AppError keeps code, no spurious details key', async () => {
    getAuditEventDetailMock.mockRejectedValueOnce(AppError.notFound(
      'Audit event not found',
      'AUDIT_EVENT_NOT_FOUND',
    ));

    const response = await request(app).get('/api/v1/admin/audit/events/hipaa/12');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('AUDIT_EVENT_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });
});

describe('auditError non-operational tail keeps the operation-labelled generic 500', () => {
  test('GET /events — 500 body is the site generic, thrown text absent', async () => {
    listAuditEventsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'audit_rows')"),
    );

    const response = await request(app).get('/api/v1/admin/audit/events');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to fetch unified audit events');
    expect(response.body.message).not.toMatch(/audit_rows/);
    expect(response.body).not.toHaveProperty('details');
  });

  test('GET /events — a statusCode-carrying NON-operational error still falls to the generic 500 (predicate kept)', async () => {
    // auditError guards on `err?.isOperational && err?.statusCode` —
    // deliberately stricter than relayAppError's own statusCode check. A raw
    // error that merely carries a statusCode must NOT be relayed off the
    // admin audit console.
    const shaped = new Error('relation "audit_log_shadow" does not exist');
    shaped.statusCode = 404;
    shaped.code = 'NOT_OPERATIONAL';
    listAuditEventsMock.mockRejectedValueOnce(shaped);

    const response = await request(app).get('/api/v1/admin/audit/events');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to fetch unified audit events');
    expect(response.body).not.toHaveProperty('code');
  });
});
