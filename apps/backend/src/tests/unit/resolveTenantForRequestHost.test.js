// W4 C2: resolveTenantForRequest is Host-first; client x-tenant-* is NOT trusted.
import { jest } from '@jest/globals';

const APOLLO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('FROM tenants') && sql.includes('slug')) {
        return params[0] === 'apollo' ? [{ id: APOLLO_ID, slug: 'apollo', status: 'active' }] : [];
      }
      return [];
    },
  },
}));

const { resolveTenantForRequest, DEFAULT_TENANT_ID } = await import('../../services/tenant/tenantService.js');

describe('resolveTenantForRequest is Host-first (W4 C2)', () => {
  it('resolves the tenant from the Host subdomain', async () => {
    expect(await resolveTenantForRequest({ hostname: 'apollo-api.localhost', headers: {} })).toBe(APOLLO_ID);
  });

  it('IGNORES a client x-tenant-id / x-tenant-slug (not trusted)', async () => {
    const req = {
      hostname: 'localhost',
      headers: { 'x-tenant-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02', 'x-tenant-slug': 'evil' },
    };
    expect(await resolveTenantForRequest(req)).toBe(DEFAULT_TENANT_ID); // bare host → default; headers ignored
  });

  it('a spoofed x-tenant-slug on a tenant subdomain cannot override the Host', async () => {
    const req = { hostname: 'apollo-api.localhost', headers: { 'x-tenant-slug': 'evil', 'x-tenant-id': 'cccccccc-cccc-4ccc-8ccc-cccccccccc03' } };
    expect(await resolveTenantForRequest(req)).toBe(APOLLO_ID); // Host wins
  });

  it('bare host → default tenant', async () => {
    expect(await resolveTenantForRequest({ hostname: 'localhost', headers: {} })).toBe(DEFAULT_TENANT_ID);
  });
});
