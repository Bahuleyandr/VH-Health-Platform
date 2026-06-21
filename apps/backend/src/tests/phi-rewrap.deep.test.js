// WS5 (W3): per-tenant field-encryption KEK + re-wrap + crypto-shred.
//
// Proves the envelope (master KEK -> per-tenant KEK -> DEK -> data):
//  - encrypt under a tenant KEK stamps the per-tenant kid and round-trips;
//  - legacy global-kid ciphertext still decrypts (grandfather);
//  - rewrapField migrates a global-kid value onto a tenant KEK, idempotently;
//  - crypto-shred (drop the tenant's wrapped KEK) makes THAT tenant's ciphertext
//    unrecoverable while another tenant's is untouched.
import prisma from '../lib/prisma.js';
import { encryptField, decryptField, rewrapField, getKeyId } from '../utils/fieldEncryption.js';
import {
  provisionTenantKek, loadTenantKekIntoProvider, cryptoShredTenant, tenantKeyId,
} from '../services/security/tenantKekProvider.js';

const TENANT_A = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a501';
const TENANT_B = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502';

async function ensureTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
    id, slug, `W3 WS5 ${slug}`,
  );
}

describe('W3 WS5 — per-tenant KEK, re-wrap, crypto-shred', () => {
  beforeAll(async () => {
    const sfx = String(Date.now() % 100000);
    await ensureTenant(TENANT_A, `w3-ws5-a-${sfx}`);
    await ensureTenant(TENANT_B, `w3-ws5-b-${sfx}`);
    await provisionTenantKek(TENANT_A);
    await provisionTenantKek(TENANT_B);
    await loadTenantKekIntoProvider(TENANT_A);
    await loadTenantKekIntoProvider(TENANT_B);
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM encryption_keys WHERE tenant_id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('encrypts under the tenant KEK (per-tenant kid) and round-trips', () => {
    const ct = encryptField('secret-A', { tenantId: TENANT_A });
    expect(getKeyId(ct)).toBe(tenantKeyId(TENANT_A));
    expect(decryptField(ct)).toBe('secret-A');
  });

  it('grandfathers legacy global-kid ciphertext (no tenant)', () => {
    const ct = encryptField('legacy-secret'); // no tenant context -> global KEK
    expect(getKeyId(ct)).toBe('local-v1');
    expect(decryptField(ct)).toBe('legacy-secret');
  });

  it('rewrapField migrates a global-kid value onto the tenant KEK, idempotently', () => {
    const global = encryptField('migrate-me');
    expect(getKeyId(global)).toBe('local-v1');

    const onTenant = rewrapField(global, { keyId: tenantKeyId(TENANT_A) });
    expect(getKeyId(onTenant)).toBe(tenantKeyId(TENANT_A));
    expect(decryptField(onTenant)).toBe('migrate-me');

    // Idempotent: re-wrapping again under the same keyId still decrypts.
    const again = rewrapField(onTenant, { keyId: tenantKeyId(TENANT_A) });
    expect(getKeyId(again)).toBe(tenantKeyId(TENANT_A));
    expect(decryptField(again)).toBe('migrate-me');
  });

  it('crypto-shred makes tenant A unrecoverable while B is untouched', async () => {
    const aCipher = encryptField('a-phi', { tenantId: TENANT_A });
    const bCipher = encryptField('b-phi', { tenantId: TENANT_B });
    expect(decryptField(aCipher)).toBe('a-phi');
    expect(decryptField(bCipher)).toBe('b-phi');

    await cryptoShredTenant(TENANT_A);

    // A's KEK is gone (evicted + wrapped material nulled) -> unrecoverable.
    expect(() => decryptField(aCipher)).toThrow();
    // B is unaffected.
    expect(decryptField(bCipher)).toBe('b-phi');
  });
});
