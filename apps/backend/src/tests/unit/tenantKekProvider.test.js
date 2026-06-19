import { jest } from '@jest/globals';

// Simulate the encryption_keys store so the provider can be unit-tested without a DB.
const store = new Map(); // tenantId -> { wrapped_key_material, status }
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $executeRawUnsafe: async (sql, tenantId, _kid, wrapped) => {
      if (sql.includes('INSERT INTO encryption_keys')) {
        store.set(tenantId, { wrapped_key_material: wrapped, status: 'active' });
      } else if (sql.includes('UPDATE encryption_keys SET status')) {
        const row = store.get(tenantId);
        if (row) { row.status = 'compromised'; row.wrapped_key_material = null; }
      }
      return 1;
    },
    $queryRawUnsafe: async (sql, tenantId) => {
      if (sql.includes('provider = \'local-tenant\'')) {
        return [...store.entries()]
          .filter(([, r]) => r.status === 'active' && r.wrapped_key_material)
          .map(([tid, r]) => ({ tenant_id: tid, wrapped_key_material: r.wrapped_key_material }));
      }
      const row = store.get(tenantId);
      if (row && row.status === 'active' && row.wrapped_key_material) {
        return [{ wrapped_key_material: row.wrapped_key_material }];
      }
      return [];
    },
  },
}));

const {
  provisionTenantKek, getTenantKek, cryptoShredTenant, resetTenantKekCacheForTesting, tenantKeyId,
} = await import('../../services/security/tenantKekProvider.js');

describe('tenantKekProvider', () => {
  beforeEach(() => {
    store.clear();
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
});
