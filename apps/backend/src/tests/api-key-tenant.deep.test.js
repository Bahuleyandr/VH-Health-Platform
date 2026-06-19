// WS4 (W3): validateApiKey authenticates DB-backed per-tenant api_keys (the key
// identifies the client + tenant), falling back to the env-var registry so the
// existing single-tenant / shared-key behaviour is unchanged.
import prisma from '../lib/prisma.js';
import { upsertApiClient, issueApiKey, revokeApiKey } from '../services/auth/apiClientService.js';
import validateApiKey from '../middleware/validateApiKey.js';

const TENANT_A = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401';
const SFX = String(Date.now() % 100000).padStart(5, '0');
// The env-var registry is built from process.env.API_KEY at module load — use
// the SAME value the registry saw (a local .env may override 'test-api-key').
const ENV_API_KEY = process.env.API_KEY;

// Drive the middleware with a minimal req/res; resolve on next() or res.json().
function runMw(headers, ip = '5.5.5.5') {
  return new Promise((resolve, reject) => {
    const req = { headers, ip };
    const res = {
      statusCode: 200,
      set() { return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ code: this.statusCode, body: b, req }); return this; },
    };
    Promise.resolve(validateApiKey(req, res, () => resolve({ code: 200, req }))).catch(reject);
  });
}

describe('validateApiKey — per-tenant DB keys + env fallback (WS4)', () => {
  let plaintext;
  let clientCode;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT_A, `w3-ws4-${SFX}`, 'W3 WS4 Tenant',
    );
    clientCode = `ws4-client-${SFX}`;
    const client = await upsertApiClient({ tenantId: TENANT_A, clientCode, displayName: 'WS4 Client' });
    const issued = await issueApiKey({ tenantId: TENANT_A, apiClientId: client.id, displayName: 'k1' });
    plaintext = issued.plaintext;
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM api_keys WHERE tenant_id=$1::uuid`, TENANT_A).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM api_clients WHERE tenant_id=$1::uuid`, TENANT_A).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id=$1::uuid`, TENANT_A).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('accepts a DB-issued key and stamps tenantId + apiClient', async () => {
    const r = await runMw({ 'x-api-key': plaintext });
    expect(r.code).toBe(200);
    expect(r.req.tenantId).toBe(TENANT_A);
    expect(r.req.apiClient).toBe(clientCode);
  });

  it('falls back to the env API_KEY (shared / default tenant)', async () => {
    expect(ENV_API_KEY).toBeTruthy(); // sanity: registry has a shared key to match
    const r = await runMw({ 'x-api-key': ENV_API_KEY });
    expect(r.code).toBe(200);
    expect(r.req.apiClient).toBe('shared');
  });

  it('rejects an unknown key (401)', async () => {
    const r = await runMw({ 'x-api-key': 'vh_unknown_key_zzz' });
    expect(r.code).toBe(401);
  });

  it('rejects a revoked DB key (401)', async () => {
    const client = await upsertApiClient({ tenantId: TENANT_A, clientCode: `ws4-rev-${SFX}`, displayName: 'WS4 Rev' });
    const issued = await issueApiKey({ tenantId: TENANT_A, apiClientId: client.id, displayName: 'k2' });
    await revokeApiKey({ tenantId: TENANT_A, id: issued.key.id, revokedReason: 'test' });
    const r = await runMw({ 'x-api-key': issued.plaintext });
    expect(r.code).toBe(401);
  });
});
