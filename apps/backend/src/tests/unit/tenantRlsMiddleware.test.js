import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';
import { getCurrentTenantContext } from '../../lib/tenantContext.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';

function runMiddleware(req) {
  let observed = null;
  tenantRlsMiddleware(req, {}, () => {
    observed = getCurrentTenantContext();
  });
  return observed;
}

describe('tenantRlsMiddleware', () => {
  it('seeds a tenant-scoped context for normal authenticated requests', () => {
    const ctx = runMiddleware({
      tenantId: TENANT_A,
      user: { role: 'DOCTOR', tenant_id: TENANT_A },
    });

    expect(ctx).toMatchObject({
      tenantId: TENANT_A,
      superAdmin: false,
      inSetTenant: false,
    });
  });

  it('keeps SUPER_ADMIN x-tenant-id overrides scoped to the target tenant, not RLS bypass', () => {
    const ctx = runMiddleware({
      tenantId: TENANT_B,
      tenantOverrideUsed: true,
      user: {
        role: 'ADMIN',
        rawRole: 'SUPER_ADMIN',
        tenant_id: TENANT_A,
      },
      get(name) {
        return String(name).toLowerCase() === 'x-tenant-id' ? TENANT_B : undefined;
      },
    });

    expect(ctx).toMatchObject({
      tenantId: TENANT_B,
      superAdmin: false,
      inSetTenant: false,
    });
  });
});
