import { isTenantRlsEnforcementEnabled, isDefaultTenantAllowed } from '../../config/tenantRlsConfig.js';

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

describe('default-tenant resolution policy (ALLOW_DEFAULT_TENANT)', () => {
  it('allows the default-tenant fallback only when explicitly enabled', () => {
    expect(isDefaultTenantAllowed({ ALLOW_DEFAULT_TENANT: 'true' })).toBe(true);
    expect(isDefaultTenantAllowed({ ALLOW_DEFAULT_TENANT: 'TRUE' })).toBe(true);
  });

  it('fails closed by default (flag absent) — independent of NODE_ENV', () => {
    expect(isDefaultTenantAllowed({})).toBe(false);
    expect(isDefaultTenantAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(isDefaultTenantAllowed({ NODE_ENV: 'development' })).toBe(false);
  });

  it('fails closed for any non-true value', () => {
    expect(isDefaultTenantAllowed({ ALLOW_DEFAULT_TENANT: 'false' })).toBe(false);
    expect(isDefaultTenantAllowed({ ALLOW_DEFAULT_TENANT: '1' })).toBe(false);
    expect(isDefaultTenantAllowed({ ALLOW_DEFAULT_TENANT: '' })).toBe(false);
  });

  it('is decoupled from AUTH_ENFORCE_TENANT_RLS', () => {
    // RLS enforcement ON does not imply the default fallback is allowed.
    expect(isDefaultTenantAllowed({ AUTH_ENFORCE_TENANT_RLS: 'true' })).toBe(false);
  });
});
