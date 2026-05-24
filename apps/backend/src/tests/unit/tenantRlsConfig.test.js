import { isTenantRlsEnforcementEnabled } from '../../config/tenantRlsConfig.js';

describe('tenant RLS enforcement config', () => {
  it('honours an explicit true flag', () => {
    expect(isTenantRlsEnforcementEnabled({
      AUTH_ENFORCE_TENANT_RLS: 'true',
      NODE_ENV: 'development',
    })).toBe(true);
  });

  it('honours an explicit false flag', () => {
    expect(isTenantRlsEnforcementEnabled({
      AUTH_ENFORCE_TENANT_RLS: 'false',
      NODE_ENV: 'production',
    })).toBe(false);
  });

  it('defaults on in production when the flag is absent', () => {
    expect(isTenantRlsEnforcementEnabled({ NODE_ENV: 'production' })).toBe(true);
  });

  it('defaults off outside production when the flag is absent', () => {
    expect(isTenantRlsEnforcementEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(isTenantRlsEnforcementEnabled({ NODE_ENV: 'development' })).toBe(false);
  });
});
