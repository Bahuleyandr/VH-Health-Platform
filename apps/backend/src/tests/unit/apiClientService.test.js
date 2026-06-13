/**
 * Phase B4 — apiClientService unit tests.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  authenticateByApiKey,
  issueApiKey,
  listApiClients,
  listApiKeys,
  revokeApiKey,
  upsertApiClient,
  __testing__,
} = await import('../../services/auth/apiClientService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('upsertApiClient', () => {
  it('rejects missing client_code', async () => {
    await expect(upsertApiClient({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/client_code is required/);
  });

  it('rejects missing display_name', async () => {
    await expect(upsertApiClient({ tenantId: TENANT, clientCode: 'X' }))
      .rejects.toThrow(/display_name is required/);
  });

  it('rejects unknown client_kind', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X', clientKind: 'magic',
    })).rejects.toThrow(/client_kind must be one of/);
  });

  it('inserts a new client with scopes + allowed_ips arrays', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, client_code: 'PARTNER1', scopes: ['fhir:read'] }]);
    const row = await upsertApiClient({
      tenantId: TENANT, clientCode: 'PARTNER1', displayName: 'Partner 1',
      scopes: ['fhir:read', 'webhook:emit'],
      allowedIps: ['192.168.0.1'],
    });
    expect(row.id).toBe(1);
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toEqual(expect.arrayContaining([['fhir:read', 'webhook:emit']]));
  });

  it('throws conflict on duplicate client_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X',
    })).rejects.toThrow(/client_code already exists/);
  });
});

describe('issueApiKey', () => {
  it('returns plaintext + persists hash only', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, key_prefix: 'vh_xxxxx', status: 'active',
    }]);
    const result = await issueApiKey({
      tenantId: TENANT, apiClientId: 1, displayName: 'rotation-2026-04',
    });
    expect(result.plaintext).toMatch(/^vh_/);
    expect(result.key.id).toBe(1);
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    // The hash should be a hex digest, never the plaintext.
    expect(params.some((p) => p === result.plaintext)).toBe(false);
    expect(params.some((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))).toBe(true);
  });

  it('rejects malformed expires_at', async () => {
    await expect(issueApiKey({
      tenantId: TENANT, apiClientId: 1, expiresAt: 'tomorrow',
    })).rejects.toThrow(/expires_at must be a valid timestamp/);
  });

  it('throws on invalid api_client_id (FK)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('insert or update violates foreign key constraint'));
    await expect(issueApiKey({ tenantId: TENANT, apiClientId: 999 }))
      .rejects.toThrow(/Invalid api_client_id/);
  });
});

describe('revokeApiKey', () => {
  it('flips status to revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'revoked' }]);
    const row = await revokeApiKey({ tenantId: TENANT, id: 1, revokedReason: 'leaked' });
    expect(row.status).toBe('revoked');
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toContain('leaked');
  });

  it('throws 404 when key already revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(revokeApiKey({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('authenticateByApiKey', () => {
  it('returns null on missing plaintext', async () => {
    expect(await authenticateByApiKey({ tenantId: TENANT })).toBeNull();
  });

  it('returns null when key not in registry', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_unknown',
    })).toBeNull();
  });

  it('returns null when key revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 1, key_status: 'revoked', client_status: 'active',
      tenant_id: TENANT, scopes: [], allowed_ips: [],
    }]);
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz',
    })).toBeNull();
  });

  it('returns null when client revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 1, key_status: 'active', client_status: 'revoked',
      tenant_id: TENANT, scopes: [], allowed_ips: [],
    }]);
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz',
    })).toBeNull();
  });

  it('returns null when key expired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 1, key_status: 'active', client_status: 'active',
      tenant_id: TENANT, scopes: [], allowed_ips: [],
      expires_at: new Date(Date.now() - 60_000),
    }]);
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz',
    })).toBeNull();
  });

  it('rejects when ip not in allowed_ips', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 1, key_status: 'active', client_status: 'active',
      tenant_id: TENANT, scopes: [], allowed_ips: ['10.0.0.1'],
    }]);
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz', ipAddress: '192.168.0.1',
    })).toBeNull();
  });

  it('returns parent client metadata + stamps last_used', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 7, key_status: 'active', client_status: 'active',
      tenant_id: TENANT, client_code: 'PARTNER1', display_name: 'Partner 1',
      client_kind: 'partner', scopes: ['fhir:read'], allowed_ips: ['10.0.0.1'],
      rate_limit_profile: 'partner_default',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // last_used_at update
    const result = await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz', ipAddress: '10.0.0.1',
    });
    expect(result.api_client_id).toBe(7);
    expect(result.scopes).toEqual(['fhir:read']);
    expect(result.client_kind).toBe('partner');
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/last_used_at = NOW\(\)/);
  });

  it('returns null when schema is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "api_keys" does not exist'));
    expect(await authenticateByApiKey({
      tenantId: TENANT, plaintext: 'vh_xyz',
    })).toBeNull();
  });
});

describe('list helpers degrade gracefully', () => {
  it('listApiClients + listApiKeys return empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "api_clients" does not exist'));
    expect(await listApiClients({ tenantId: TENANT })).toEqual({ clients: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "api_keys" does not exist'));
    expect(await listApiKeys({ tenantId: TENANT })).toEqual({ keys: [], count: 0 });
  });
});

describe('hashApiKey', () => {
  it('produces stable hashes for the same plaintext', () => {
    const a = __testing__.hashApiKey('vh_test123');
    const b = __testing__.hashApiKey('vh_test123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different plaintexts', () => {
    const a = __testing__.hashApiKey('vh_test123');
    const b = __testing__.hashApiKey('vh_different');
    expect(a).not.toBe(b);
  });
});
