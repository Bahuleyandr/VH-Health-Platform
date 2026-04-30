/**
 * Phase E3 — encryptionKeyRegistryService unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  listEncryptionKeys,
  markKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateActiveKey,
} = await import('../../services/security/encryptionKeyRegistryService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('registerEncryptionKey', () => {
  it('rejects missing key_id', async () => {
    await expect(registerEncryptionKey({ tenantId: TENANT })).rejects.toThrow(/key_id is required/);
  });
  it('rejects unknown provider', async () => {
    await expect(registerEncryptionKey({ tenantId: TENANT, keyId: 'k1', provider: 'magic' }))
      .rejects.toThrow(/provider must be one of/);
  });
  it('inserts an active key', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, key_id: 'k1', status: 'active' }]);
    const row = await registerEncryptionKey({ tenantId: TENANT, keyId: 'k1', provider: 'env' });
    expect(row.id).toBe(1);
  });
  it('throws conflict on duplicate key_id', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(registerEncryptionKey({ tenantId: TENANT, keyId: 'k1' }))
      .rejects.toThrow(/already registered/);
  });
});

describe('rotateActiveKey', () => {
  it('marks the previous active key as retiring and inserts the new one', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, key_id: 'k1' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, key_id: 'k2', status: 'active', rotated_from: 1 }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k2' });
    expect(row.id).toBe(2);
    expect(row.rotated_from).toBe(1);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/status = 'retiring'/);
  });

  it('handles tenant with no active key by inserting first key', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, key_id: 'k1', status: 'active', rotated_from: null }]);
    const row = await rotateActiveKey({ tenantId: TENANT, newKeyId: 'k1' });
    expect(row.id).toBe(5);
    expect(row.rotated_from).toBeNull();
    expect(queryUnsafeMock.mock.calls).toHaveLength(2);
  });
});

describe('retireEncryptionKey', () => {
  it('throws 404 when not found or already retired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(retireEncryptionKey({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  it('flips status to retired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'retired' }]);
    const row = await retireEncryptionKey({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('retired');
  });
});

describe('markKeyCompromised', () => {
  it('flips status to compromised + records reason in metadata', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'compromised' }]);
    const row = await markKeyCompromised({ tenantId: TENANT, id: 1, reason: 'Vault leak 2026-04-29' });
    expect(row.status).toBe('compromised');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/jsonb_build_object/);
  });
});

describe('listEncryptionKeys', () => {
  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "encryption_keys" does not exist'));
    expect(await listEncryptionKeys({ tenantId: TENANT })).toEqual({ keys: [], count: 0 });
  });
});
