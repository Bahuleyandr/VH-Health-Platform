import { jest } from '@jest/globals';

const resolveTenantForRequestMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantForRequest: resolveTenantForRequestMock,
}));

const { default: preAuthTenantContextMiddleware } = await import('../../middleware/preAuthTenantContextMiddleware.js');
const { getCurrentTenantId, runInTenantContext } = await import('../../lib/tenantContext.js');

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function run(req = { headers: { host: 'localhost' } }) {
  return new Promise((resolve) => {
    const seen = {};
    const next = (err) => {
      seen.err = err;
      // What the downstream handler observes, including across an await.
      seen.tenantId = getCurrentTenantId();
      Promise.resolve().then(() => {
        seen.tenantIdAfterAwait = getCurrentTenantId();
        resolve(seen);
      });
    };
    preAuthTenantContextMiddleware(req, {}, next);
  });
}

describe('preAuthTenantContextMiddleware', () => {
  beforeEach(() => {
    resolveTenantForRequestMock.mockReset();
  });

  it('runs the rest of the chain inside the tenant resolved from the request host', async () => {
    resolveTenantForRequestMock.mockResolvedValue(TENANT_A);
    const req = { headers: { host: 'acme-api.vhhealth.app' } };

    const seen = await run(req);

    expect(resolveTenantForRequestMock).toHaveBeenCalledWith(req);
    expect(seen.err).toBeUndefined();
    expect(seen.tenantId).toBe(TENANT_A);
    expect(seen.tenantIdAfterAwait).toBe(TENANT_A);
    expect(req.tenantId).toBeUndefined(); // W1: req.tenantId stays untouched pre-auth
  });

  it('leaves an already-seeded tenant context alone', async () => {
    resolveTenantForRequestMock.mockResolvedValue(TENANT_A);

    const seen = await runInTenantContext(TENANT_B, () => run());

    expect(resolveTenantForRequestMock).not.toHaveBeenCalled();
    expect(seen.tenantId).toBe(TENANT_B);
  });

  it('replaces the empty context the global RLS middleware seeds on public routes', async () => {
    resolveTenantForRequestMock.mockResolvedValue(TENANT_A);

    const seen = await runInTenantContext(null, () => run());

    expect(seen.tenantId).toBe(TENANT_A);
  });

  it('forwards an unresolvable tenant to the error handler without seeding a context', async () => {
    const failure = Object.assign(new Error('Unknown or inactive tenant'), { code: 'TENANT_NOT_RESOLVED' });
    resolveTenantForRequestMock.mockRejectedValue(failure);

    const seen = await run({ headers: { host: 'ghost-api.vhhealth.app' } });

    expect(seen.err).toBe(failure);
    expect(seen.tenantId).toBeNull();
  });
});
