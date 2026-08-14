import { jest } from '@jest/globals';

// Simulate the encryption_keys store so the provider can be unit-tested without a
// DB. Rows are keyed like the real table's (tenant_id, key_id) unique index — one
// row per KEK VERSION — and the UPDATE path enforces migration 672's rule that
// tenant KEK material may only ever be CLEARED, never replaced or refilled. A
// provider that tried to write over a live key id therefore fails here exactly as
// it does in Postgres.
const rows = []; // { id, tenant_id, key_id, status, wrapped_key_material }
let nextRowId = 1;

const versionOf = keyId => Number(/:v(\d+)$/.exec(String(keyId))?.[1] ?? 0);
const tenantKekRows = tenantId => rows.filter(r => r.tenant_id === tenantId && versionOf(r.key_id) > 0);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO encryption_keys')) {
        const [tenantId, keyId, wrapped] = params;
        // ON CONFLICT (tenant_id, key_id) DO NOTHING
        if (rows.some(r => r.tenant_id === tenantId && r.key_id === keyId)) return [];
        rows.push({
          id: nextRowId++,
          tenant_id: tenantId,
          key_id: keyId,
          status: 'active',
          wrapped_key_material: wrapped,
        });
        return [{ key_id: keyId }];
      }

      if (sql.includes('UPDATE encryption_keys')) { // crypto-shred
        if (!/wrapped_key_material = NULL/.test(sql)) {
          throw new Error('23514 tenant KEK material is immutable; provision the next version');
        }
        const [tenantId] = params;
        const shredded = [];
        for (const row of tenantKekRows(tenantId)) {
          row.status = 'compromised';
          row.wrapped_key_material = null;
          shredded.push({ key_id: row.key_id });
        }
        return shredded;
      }

      if (sql.includes('provider = \'local-tenant\'')) { // startup preload
        return rows
          .filter(r => r.status === 'active' && r.wrapped_key_material)
          .sort((a, b) => versionOf(a.key_id) - versionOf(b.key_id))
          .map(r => ({
            tenant_id: r.tenant_id,
            key_id: r.key_id,
            wrapped_key_material: r.wrapped_key_material,
          }));
      }

      const [tenantId] = params; // every version for one tenant, highest first
      return tenantKekRows(tenantId)
        .sort((a, b) => versionOf(b.key_id) - versionOf(a.key_id))
        .map(r => ({ ...r }));
    },
  },
}));

const {
  provisionTenantKek, getTenantKek, cryptoShredTenant, resetTenantKekCacheForTesting, tenantKeyId,
  preloadAllTenantKeks, activeTenantKeyId,
} = await import('../../services/security/tenantKekProvider.js');

describe('tenantKekProvider', () => {
  beforeEach(() => {
    rows.length = 0;
    nextRowId = 1;
    resetTenantKekCacheForTesting();
  });

  it('tenantKeyId is per-tenant', () => {
    expect(tenantKeyId('abc')).toBe('t:abc:v1');
  });

  it('provision then load (from the store) round-trips a 32-byte KEK', async () => {
    await provisionTenantKek('tA');
    resetTenantKekCacheForTesting(); // force the DB-load + unwrap path
    const kek = await getTenantKek('tA');
    expect(Buffer.isBuffer(kek)).toBe(true);
    expect(kek).toHaveLength(32);
    // Stable across loads (deterministic unwrap of the same wrapped material).
    resetTenantKekCacheForTesting();
    expect((await getTenantKek('tA')).equals(kek)).toBe(true);
  });

  it('two tenants get different KEKs', async () => {
    await provisionTenantKek('tA');
    await provisionTenantKek('tB');
    resetTenantKekCacheForTesting();
    const a = await getTenantKek('tA');
    const b = await getTenantKek('tB');
    expect(a.equals(b)).toBe(false);
  });

  it('crypto-shred drops the wrapped material so the KEK can no longer load', async () => {
    await provisionTenantKek('tA');
    await cryptoShredTenant('tA');
    resetTenantKekCacheForTesting();
    await expect(getTenantKek('tA')).rejects.toThrow();
  });

  it('re-provisioning is idempotent — it reuses the active version, never rewrites it', async () => {
    const first = await provisionTenantKek('tA');
    const material = rows[0].wrapped_key_material;
    resetTenantKekCacheForTesting();

    const second = await provisionTenantKek('tA');

    expect(second).toMatchObject({ keyId: first.keyId, version: 1, provisioned: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].wrapped_key_material).toBe(material);
  });

  it('a crypto-shredded tenant is re-provisioned as the NEXT version, leaving v1 shredded', async () => {
    await provisionTenantKek('tA');
    const beforeShred = await getTenantKek('tA');
    await cryptoShredTenant('tA');

    const reprovisioned = await provisionTenantKek('tA');

    expect(reprovisioned).toMatchObject({ keyId: 't:tA:v2', version: 2, provisioned: true });
    // v1 stays retired and empty — the shred is not undone.
    expect(rows.find(r => r.key_id === 't:tA:v1')).toMatchObject({
      status: 'compromised',
      wrapped_key_material: null,
    });
    // The new version is a different key: shredded ciphertext stays unrecoverable.
    resetTenantKekCacheForTesting();
    const afterShred = await getTenantKek('tA');
    expect(afterShred).toHaveLength(32);
    expect(afterShred.equals(beforeShred)).toBe(false);
  });

  it('a restart (startup preload) picks up the re-provisioned version, not the shredded one', async () => {
    await provisionTenantKek('tA');
    await cryptoShredTenant('tA');
    await provisionTenantKek('tA');

    resetTenantKekCacheForTesting(); // fresh process
    const loaded = await preloadAllTenantKeks();

    expect(loaded).toBe(1); // only v2 still has material
    expect(await activeTenantKeyId('tA')).toBe('t:tA:v2');
    expect(await getTenantKek('tA')).toHaveLength(32);
  });

  it('a second shred + re-provision keeps counting up (v3), never reusing a burnt key id', async () => {
    await provisionTenantKek('tA');
    await cryptoShredTenant('tA');
    await provisionTenantKek('tA');
    await cryptoShredTenant('tA');

    const third = await provisionTenantKek('tA');

    expect(third.keyId).toBe('t:tA:v3');
    expect(rows.map(r => r.key_id)).toEqual(['t:tA:v1', 't:tA:v2', 't:tA:v3']);
  });
});
