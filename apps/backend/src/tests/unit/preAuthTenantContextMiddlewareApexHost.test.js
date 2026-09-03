import { jest } from '@jest/globals';

// The pre-auth tenant context must NOT be a per-tenant-subdomain feature. The
// single-tenant deployment on the apex host is the common case, and a
// middleware that only did something on `<slug>-api.<base>` would be exactly
// the "wired but can never fire" shape this repository polices. This suite
// uses the REAL resolver (tenantService.tenantFromHost) so the claim is pinned
// as behaviour: the bare base host and the apex hosts resolve to the default
// tenant without touching the database, and the chain runs scoped to it.

// tenantService imports the prisma singleton; the bare-host and apex paths
// never query it, so a stub is enough and keeps this a pure unit test.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenant: async (_tenantId, fn) => fn({}),
  setTenantTx: async (_tenantId, fn) => fn({}),
}));

const { default: preAuthTenantContextMiddleware } = await import('../../middleware/preAuthTenantContextMiddleware.js');
const { getCurrentTenantId } = await import('../../lib/tenantContext.js');
const { DEFAULT_TENANT_ID } = await import('../../services/tenant/tenantService.js');

function run(host) {
  return new Promise((resolve) => {
    const req = { headers: { host } };
    preAuthTenantContextMiddleware(req, {}, (err) => resolve({ err, tenantId: getCurrentTenantId() }));
  });
}

describe('preAuthTenantContextMiddleware on the apex host', () => {
  let savedBaseHost;

  beforeAll(() => {
    savedBaseHost = process.env.TENANT_BASE_HOST;
    process.env.TENANT_BASE_HOST = 'vhhealth.app,localhost';
  });

  afterAll(() => {
    if (savedBaseHost === undefined) delete process.env.TENANT_BASE_HOST;
    else process.env.TENANT_BASE_HOST = savedBaseHost;
  });

  it.each([
    ['the bare base host', 'localhost'],
    ['the bare base host with a port', 'localhost:5000'],
    ['the API apex', 'api.vhhealth.app'],
    ['the admin apex', 'admin.vhhealth.app'],
    ['a host outside the base domains', 'example.invalid'],
  ])('seeds the default tenant for %s', async (_label, host) => {
    const seen = await run(host);
    expect(seen.err).toBeUndefined();
    expect(seen.tenantId).toBe(DEFAULT_TENANT_ID);
  });
});
