// W4 C1: parse the tenant slug from a request Host (subdomain), the trust-by-
// topology signal. Pure-function tests (no DB).
import { parseTenantSlug } from '../../services/tenant/tenantService.js';

const BASES = ['api.vhhealth.app', 'localhost'];

describe('parseTenantSlug', () => {
  it('bare base host → null (default tenant)', () => {
    expect(parseTenantSlug('api.vhhealth.app', BASES)).toBeNull();
    expect(parseTenantSlug('localhost', BASES)).toBeNull();
  });

  it('one subdomain label → slug', () => {
    expect(parseTenantSlug('apollo.api.vhhealth.app', BASES)).toBe('apollo');
    expect(parseTenantSlug('apollo.localhost', BASES)).toBe('apollo');
  });

  it('host not under any base → null (not our domain → default)', () => {
    expect(parseTenantSlug('evil.com', BASES)).toBeNull();
    expect(parseTenantSlug('', BASES)).toBeNull();
  });

  it('is case-insensitive and strips the port', () => {
    expect(parseTenantSlug('Apollo.LOCALHOST:5000', BASES)).toBe('apollo');
    expect(parseTenantSlug('APOLLO.api.vhhealth.app:443', BASES)).toBe('apollo');
  });

  it('takes the leftmost label for a multi-label prefix', () => {
    expect(parseTenantSlug('apollo.staging.api.vhhealth.app', BASES)).toBe('apollo');
  });

  it('defaults baseHosts from TENANT_BASE_HOST when not passed', () => {
    const prev = process.env.TENANT_BASE_HOST;
    process.env.TENANT_BASE_HOST = 'api.example.com, localhost';
    expect(parseTenantSlug('clinic.api.example.com')).toBe('clinic');
    expect(parseTenantSlug('api.example.com')).toBeNull();
    if (prev === undefined) delete process.env.TENANT_BASE_HOST;
    else process.env.TENANT_BASE_HOST = prev;
  });
});
