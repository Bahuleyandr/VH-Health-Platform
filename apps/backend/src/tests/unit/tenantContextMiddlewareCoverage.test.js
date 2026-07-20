// src/tests/unit/tenantContextMiddlewareCoverage.test.js
//
// Coverage-focused unit suite for the tenantContextMiddleware DEFAULT export
// (roadmap B3.2 — the RLS domain). Companion to
// src/tests/unit/tenantContextMiddleware.test.js, which only covers the pure
// buildTenantContext helper. This file drives the request-time resolution flow:
//   - tenant from req.user.tenant_id / req.user.tenantId claim
//   - SUPER_ADMIN x-tenant-id override: reason-missing 400, accepted override +
//     audit write (success + swallowed-failure), and the rawRole path
//   - users.tenant_id lookup fallback (resolveTenantForUser)
//   - fail-closed: no tenant + enforced → 403 TENANT_CONTEXT_REQUIRED
//   - inactive-tenant rejection (+ the SUPER_ADMIN bypass of it)
//   - the catch path in both enforced (403) and permissive (default-tenant) modes
//   - req.user enrichment (tenantId / tenantRegion / complianceProfile)
//
// tenantService + tenantRlsConfig + prisma + logger are mocked; AppError is left
// REAL so the middleware's `instanceof AppError` branch is exercised. No DB.

import { jest } from '@jest/globals';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_A = '00000000-0000-4000-8000-0000000000aa';
const TENANT_B = '00000000-0000-4000-8000-0000000000bb';

const mockGetTenantById = jest.fn();
const mockResolveTenantForUser = jest.fn();
const mockAllowDefault = jest.fn();
const mockExecuteRawUnsafe = jest.fn();

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  getTenantById: mockGetTenantById,
  resolveTenantForUser: mockResolveTenantForUser,
  resolveTenantOrThrow: (req) => req?.tenantId || DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
  // W4 C1/C4: the middleware imports these for the Host↔token cross-check. These
  // coverage cases use bare hosts (no subdomain) → parseTenantSlug returns null
  // → the cross-check is skipped (the dedicated C4 deep test covers the path).
  parseTenantSlug: () => null,
  tenantFromHost: jest.fn().mockResolvedValue(null),
}));
jest.unstable_mockModule('../../config/tenantRlsConfig.js', () => ({
  // W1: tenantContextMiddleware now keys resolution policy on
  // isDefaultTenantAllowed (NOT isTenantRlsEnforcementEnabled). allowDefault=true
  // is the permissive single-tenant path; allowDefault=false is fail-closed.
  isDefaultTenantAllowed: mockAllowDefault,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $executeRawUnsafe: mockExecuteRawUnsafe },
  setTenantTx: async (_t, fn) => fn(),
  setTenant: async (_t, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const tenantContextMiddleware = (await import('../../middleware/tenantContextMiddleware.js')).default;

function makeReq(overrides = {}) {
  const headers = overrides.headers || {};
  return {
    id: 'req-1',
    ip: '127.0.0.1',
    body: overrides.body || {},
    user: overrides.user,
    get(name) { return headers[String(name).toLowerCase()]; },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAllowDefault.mockReturnValue(true); // permissive single-tenant default
  mockGetTenantById.mockResolvedValue({ id: TENANT_A, status: 'active', region: 'IN', compliance_profile: 'DPDP' });
  mockResolveTenantForUser.mockResolvedValue(null);
  mockExecuteRawUnsafe.mockResolvedValue(1);
});

describe('tenantContextMiddleware — claim resolution', () => {
  it('resolves tenant from req.user.tenant_id and enriches req.user', async () => {
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_A } });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_A);
    expect(req.user.tenantId).toBe(TENANT_A);
    expect(req.user.tenantRegion).toBe('IN');
    expect(req.user.complianceProfile).toBe('DPDP');
    expect(req.tenantOverrideUsed).toBe(false);
  });

  it('resolves tenant from the camelCase req.user.tenantId claim', async () => {
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR', tenantId: TENANT_A } });
    await tenantContextMiddleware(req, {}, () => {});
    expect(req.tenantId).toBe(TENANT_A);
  });

  it('falls back to resolveTenantForUser when no claim is present', async () => {
    mockResolveTenantForUser.mockResolvedValue(TENANT_A);
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR' } });
    await tenantContextMiddleware(req, {}, () => {});
    expect(mockResolveTenantForUser).toHaveBeenCalledWith('u1', { failClosed: false });
    expect(req.tenantId).toBe(TENANT_A);
  });

  it('accepts a DB-backed API client only when its tenant matches the JWT tenant', async () => {
    const req = makeReq({
      apiClientTenantId: TENANT_A,
      user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_A },
    });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_A);
  });

  it('rejects a DB-backed API client from another tenant before tenant data is loaded', async () => {
    const req = makeReq({
      apiClientTenantId: TENANT_A,
      user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_B },
    });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeDefined();
    expect(nextErr.statusCode).toBe(403);
    expect(nextErr.code).toBe('TENANT_API_CLIENT_MISMATCH');
    expect(mockGetTenantById).not.toHaveBeenCalled();
  });

  it('falls back to the default tenant for unauthenticated requests', async () => {
    mockGetTenantById.mockResolvedValue({ id: DEFAULT_TENANT_ID, status: 'active', region: 'IN' });
    const req = makeReq({ user: undefined });
    await tenantContextMiddleware(req, {}, () => {});
    expect(req.tenantId).toBe(DEFAULT_TENANT_ID);
  });
});

describe('tenantContextMiddleware — SUPER_ADMIN override', () => {
  it('rejects an override that lacks a reason header with 400', async () => {
    const req = makeReq({
      user: { uid: 'admin', role: 'ADMIN', rawRole: 'SUPER_ADMIN', tenant_id: TENANT_A },
      headers: { 'x-tenant-id': TENANT_B },
    });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeDefined();
    expect(nextErr.statusCode).toBe(400);
    expect(nextErr.code).toBe('TENANT_OVERRIDE_REASON_REQUIRED');
  });

  it('accepts an override with a valid reason and writes an audit row', async () => {
    const req = makeReq({
      user: { uid: 'admin', role: 'SUPER_ADMIN', tenant_id: TENANT_A },
      headers: { 'x-tenant-id': TENANT_B, 'x-tenant-override-reason': 'debugging a P1 incident' },
    });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_B);
    expect(req.tenantOverrideUsed).toBe(true);
    // Audit write is fire-and-forget via setImmediate — flush the queue.
    await new Promise((r) => setImmediate(r));
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('TENANT_OVERRIDE_USED'),
      'admin', TENANT_B, TENANT_A, 'debugging a P1 incident', 'req-1', '127.0.0.1',
    );
  });

  it('rejects a cross-tenant DB API client override without recording successful-override evidence', async () => {
    const req = makeReq({
      apiClientTenantId: TENANT_A,
      user: { uid: 'admin', role: 'SUPER_ADMIN', tenant_id: TENANT_A },
      headers: { 'x-tenant-id': TENANT_B, 'x-tenant-override-reason': 'debugging a P1 incident' },
    });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    await new Promise((r) => setImmediate(r));

    expect(nextErr).toBeDefined();
    expect(nextErr.statusCode).toBe(403);
    expect(nextErr.code).toBe('TENANT_API_CLIENT_MISMATCH');
    expect(mockGetTenantById).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('swallows an audit-write failure without blocking the override', async () => {
    mockExecuteRawUnsafe.mockRejectedValue(new Error('audit table gone'));
    const req = makeReq({
      user: { uid: 'admin', role: 'SUPER_ADMIN', tenant_id: TENANT_A },
      headers: { 'x-tenant-id': TENANT_B, 'x-tenant-override-reason': 'incident response' },
    });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    await new Promise((r) => setImmediate(r));
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_B);
  });

  it('reads the override reason from the request body when no header is set', async () => {
    const req = makeReq({
      user: { uid: 'admin', role: 'SUPER_ADMIN', tenant_id: TENANT_A },
      headers: { 'x-tenant-id': TENANT_B },
      body: { tenant_override_reason: 'reason via body field' },
    });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_B);
  });
});

describe('tenantContextMiddleware — enforcement + tenant status', () => {
  it('fails closed with 403 when default is not allowed and no tenant resolves', async () => {
    mockAllowDefault.mockReturnValue(false);
    mockResolveTenantForUser.mockResolvedValue(null);
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR' } });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr.statusCode).toBe(403);
    expect(nextErr.code).toBe('TENANT_CONTEXT_REQUIRED');
    // resolveTenantForUser must be called fail-closed so a miss returns null.
    expect(mockResolveTenantForUser).toHaveBeenCalledWith('u1', { failClosed: true });
  });

  it('lets a public/pre-auth request (no req.user) proceed with a null tenant when fail-closed', async () => {
    mockAllowDefault.mockReturnValue(false);
    const req = makeReq({ user: undefined });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBeNull();
    expect(req.tenant).toBeNull();
  });

  it('rejects an inactive tenant for a non-super-admin', async () => {
    mockGetTenantById.mockResolvedValue({ id: TENANT_A, status: 'suspended', region: 'IN' });
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_A } });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeInstanceOf(Error);
    expect(nextErr.message).toMatch(/Tenant is not active/);
  });

  it('lets a SUPER_ADMIN proceed against an inactive tenant', async () => {
    mockGetTenantById.mockResolvedValue({ id: TENANT_A, status: 'suspended', region: 'IN' });
    const req = makeReq({ user: { uid: 'admin', role: 'SUPER_ADMIN', tenant_id: TENANT_A } });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(TENANT_A);
  });
});

describe('tenantContextMiddleware — catch path', () => {
  it('falls back to the default tenant when a lookup throws in permissive mode', async () => {
    mockGetTenantById.mockRejectedValue(new Error('db down'));
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_A } });
    let nextErr = 'unset';
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr).toBeUndefined();
    expect(req.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(req.user.tenantId).toBe(DEFAULT_TENANT_ID);
  });

  it('forwards a 403 AppError when a lookup throws in fail-closed mode', async () => {
    mockAllowDefault.mockReturnValue(false);
    mockGetTenantById.mockRejectedValue(new Error('db down'));
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR', tenant_id: TENANT_A } });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr.statusCode).toBe(403);
    expect(nextErr.code).toBe('TENANT_CONTEXT_UNAVAILABLE');
  });

  it('re-forwards an AppError unchanged from the catch in fail-closed mode', async () => {
    mockAllowDefault.mockReturnValue(false);
    // resolveTenantForUser throwing an AppError should be forwarded as-is.
    const { AppError } = await import('../../utils/AppError.js');
    mockResolveTenantForUser.mockRejectedValue(AppError.forbidden('boom', 'CUSTOM_CODE'));
    const req = makeReq({ user: { uid: 'u1', role: 'DOCTOR' } });
    let nextErr;
    await tenantContextMiddleware(req, {}, (e) => { nextErr = e; });
    expect(nextErr.code).toBe('CUSTOM_CODE');
  });
});
