import { buildTenantContext } from '../../middleware/tenantContextMiddleware.js';

const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

describe('tenantContextMiddleware tenant context hydration', () => {
  it('keeps tenant region non-optional and fail-closed for incomplete tenant rows', () => {
    const context = buildTenantContext(TENANT_ID, {
      id: TENANT_ID,
      slug: 'incomplete',
      name: 'Incomplete Tenant',
      region: null,
      compliance_profile: null,
      status: 'active',
    });

    expect(context).toMatchObject({
      id: TENANT_ID,
      region: 'OTHER',
      compliance_profile: 'DPDP',
      status: 'active',
      region_resolution: 'missing_tenant_region',
    });
  });

  it('keeps the backwards-compatible default tenant region explicit', () => {
    const context = buildTenantContext(TENANT_ID, null);

    expect(context).toMatchObject({
      id: TENANT_ID,
      region: 'IN',
      compliance_profile: 'DPDP',
      status: 'active',
      region_resolution: 'default_tenant_fallback',
    });
  });
});
