// W4 C1 (flat <slug>-api host model): parse the tenant slug from a request Host.
// The per-tenant API host is <slug>-api.<base> (a single 1st-level label so
// Cloudflare Universal SSL `*.<base>` covers it free — no ACM). Pure tests, no DB.
import { parseTenantSlug } from '../../services/tenant/tenantService.js';

const BASES = ['vhhealth.app', 'localhost'];

describe('parseTenantSlug (flat <slug>-api model)', () => {
  it('bare base host / apex / non-tenant label → null (default tenant)', () => {
    expect(parseTenantSlug('vhhealth.app', BASES)).toBeNull();
    expect(parseTenantSlug('localhost', BASES)).toBeNull();
    expect(parseTenantSlug('api.vhhealth.app', BASES)).toBeNull();    // apex API host
    expect(parseTenantSlug('admin.vhhealth.app', BASES)).toBeNull();  // single admin host
    expect(parseTenantSlug('www.vhhealth.app', BASES)).toBeNull();
    expect(parseTenantSlug('apollo.vhhealth.app', BASES)).toBeNull(); // no -api suffix
  });

  it('<slug>-api host → slug (the -api suffix is stripped)', () => {
    expect(parseTenantSlug('apollo-api.vhhealth.app', BASES)).toBe('apollo');
    expect(parseTenantSlug('apollo-api.localhost', BASES)).toBe('apollo');
    // A tenant may even be named "admin" — admin-api.* is distinct from admin.*
    expect(parseTenantSlug('admin-api.vhhealth.app', BASES)).toBe('admin');
  });

  it('host not under any base → null (not our domain → default)', () => {
    expect(parseTenantSlug('evil.com', BASES)).toBeNull();
    expect(parseTenantSlug('apollo-api.evil.com', BASES)).toBeNull();
    expect(parseTenantSlug('', BASES)).toBeNull();
  });

  it('is case-insensitive and strips the port', () => {
    expect(parseTenantSlug('Apollo-API.LOCALHOST:5000', BASES)).toBe('apollo');
    expect(parseTenantSlug('APOLLO-API.vhhealth.app:443', BASES)).toBe('apollo');
  });

  it('takes the leftmost label for a multi-label prefix', () => {
    expect(parseTenantSlug('apollo-api.staging.vhhealth.app', BASES)).toBe('apollo');
  });

  it('defaults baseHosts from TENANT_BASE_HOST when not passed', () => {
    const prev = process.env.TENANT_BASE_HOST;
    process.env.TENANT_BASE_HOST = 'example.com, localhost';
    expect(parseTenantSlug('clinic-api.example.com')).toBe('clinic');
    expect(parseTenantSlug('api.example.com')).toBeNull();
    if (prev === undefined) delete process.env.TENANT_BASE_HOST;
    else process.env.TENANT_BASE_HOST = prev;
  });
});
