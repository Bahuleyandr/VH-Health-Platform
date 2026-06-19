// W1 (multi-tenancy program) — fail-closed tenant resolution helpers.
// resolveTenantOrThrow is the single sanctioned replacement for the scattered
// `req.tenantId || … || DEFAULT_TENANT_ID` resolvers; resolveTenantForUser must
// stop silently defaulting on a lookup miss when called fail-closed, so the
// middleware's 403 gate can actually fire.
import { jest } from '@jest/globals';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_A = '11111111-1111-4111-8111-111111111111';

const mockQueryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: mockQueryRawUnsafe },
  setTenant: async (_t, fn) => fn(),
  setTenantTx: async (_t, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveTenantOrThrow, requireTenantId, resolveTenantForUser } = await import('../../services/tenant/tenantService.js');

const savedFlag = process.env.ALLOW_DEFAULT_TENANT;
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ALLOW_DEFAULT_TENANT;
  else process.env.ALLOW_DEFAULT_TENANT = savedFlag;
  jest.clearAllMocks();
});

describe('resolveTenantOrThrow', () => {
  it('returns the resolved req.tenantId when present', () => {
    expect(resolveTenantOrThrow({ tenantId: TENANT_A })).toBe(TENANT_A);
  });

  it('throws 403 TENANT_CONTEXT_REQUIRED when no tenant and default not allowed', () => {
    delete process.env.ALLOW_DEFAULT_TENANT;
    let err;
    try { resolveTenantOrThrow({}); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('TENANT_CONTEXT_REQUIRED');
  });

  it('returns the default tenant when ALLOW_DEFAULT_TENANT=true', () => {
    process.env.ALLOW_DEFAULT_TENANT = 'true';
    expect(resolveTenantOrThrow({})).toBe(DEFAULT_TENANT_ID);
  });
});

describe('requireTenantId (service-layer value guard)', () => {
  it('returns a truthy tenant id unchanged', () => {
    expect(requireTenantId(TENANT_A)).toBe(TENANT_A);
  });

  it('throws 403 TENANT_CONTEXT_REQUIRED on a falsy tenant when default not allowed', () => {
    delete process.env.ALLOW_DEFAULT_TENANT;
    let err;
    try { requireTenantId(null); } catch (e) { err = e; }
    expect(err?.statusCode).toBe(403);
    expect(err?.code).toBe('TENANT_CONTEXT_REQUIRED');
  });

  it('returns the default tenant on a falsy tenant when ALLOW_DEFAULT_TENANT=true', () => {
    process.env.ALLOW_DEFAULT_TENANT = 'true';
    expect(requireTenantId(undefined)).toBe(DEFAULT_TENANT_ID);
  });
});

describe('resolveTenantForUser — fail-closed lookup', () => {
  it('returns null on a lookup miss when failClosed (no silent default)', async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);
    expect(await resolveTenantForUser('u1', { failClosed: true })).toBeNull();
  });

  it('returns null for a missing uid when failClosed', async () => {
    expect(await resolveTenantForUser(null, { failClosed: true })).toBeNull();
  });

  it('still returns the default on a miss when NOT failClosed (legacy single-tenant)', async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);
    expect(await resolveTenantForUser('u1', { failClosed: false })).toBe(DEFAULT_TENANT_ID);
  });

  it('returns the resolved tenant_id on a hit regardless of policy', async () => {
    mockQueryRawUnsafe.mockResolvedValue([{ tenant_id: TENANT_A }]);
    expect(await resolveTenantForUser('u1', { failClosed: true })).toBe(TENANT_A);
  });
});
