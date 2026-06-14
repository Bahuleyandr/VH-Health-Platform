// src/tests/unit/apiClientServiceCoverage.test.js
//
// Coverage-focused unit suite for apiClientService (roadmap B3.2). Companion to
// src/tests/unit/apiClientService.test.js, which already covers the insert path,
// duplicate/FK conflicts, the authenticateByApiKey decision matrix, and
// schema-missing degradation. This file drives the previously-uncovered surface:
//   - upsertApiClient UPDATE branch (id set) + its not-found 404.
//   - the input-normalisation helper error branches (normalizeId / maybeUuid /
//     normalizeStringArray / normalizeJsonObject / normalizeEnum on keys).
//   - listApiClients / listApiKeys happy paths WITH filters applied.
//   - revokeApiKey reason-null branch.
//   - the timing-safe IP allowlist *match* (success) path of authenticateByApiKey.
//
// Fully mocked prisma ($queryRawUnsafe only — the service uses no typed models).
// No DB / network. Mirrors the existing apiClientService.test.js mock shape.

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
  upsertApiClient,
  listApiClients,
  listApiKeys,
  revokeApiKey,
  issueApiKey,
  authenticateByApiKey,
} = await import('../../services/auth/apiClientService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// =====================================================================
// upsertApiClient — UPDATE branch + validation helper errors
// =====================================================================
describe('upsertApiClient — update path', () => {
  it('updates an existing client when a valid id is supplied', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, client_code: 'EXISTING', display_name: 'Existing' }]);

    const row = await upsertApiClient({
      tenantId: TENANT, id: 5, clientCode: 'EXISTING', displayName: 'Existing',
      description: 'updated', scopes: ['fhir:read'], allowedIps: ['10.0.0.5'],
      rateLimitProfile: 'partner', contactEmail: 'x@y.z', contactPhone: '+1', metadata: { k: 'v' },
    });

    expect(row.id).toBe(5);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE api_clients SET/);
    // id + tenant are the last two bound params.
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params[params.length - 2]).toBe(5);
    expect(params[params.length - 1]).toBe(TENANT);
  });

  it('throws 404 when the update matches no row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // no row updated
    await expect(upsertApiClient({
      tenantId: TENANT, id: 999, clientCode: 'X', displayName: 'X',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a truthy-but-invalid id (normalizeId branch)', async () => {
    // id must be truthy to enter the UPDATE branch (`if (id)`); a negative
    // value is truthy yet fails normalizeId's positive-integer guard.
    await expect(upsertApiClient({
      tenantId: TENANT, id: -1, clientCode: 'X', displayName: 'X',
    })).rejects.toThrow(/api_client id must be a positive integer/);
  });

  it('rejects an invalid status enum', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X', status: 'frozen',
    })).rejects.toThrow(/status must be one of/);
  });

  it('rejects scopes that is not an array', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X', scopes: 'fhir:read',
    })).rejects.toThrow(/scopes must be an array of strings/);
  });

  it('rejects an over-length scopes array', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X',
      scopes: Array.from({ length: 101 }, (_, i) => `s${i}`),
    })).rejects.toThrow(/scopes max length is 100/);
  });

  it('rejects metadata that is not a plain object', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X', metadata: ['not', 'an', 'object'],
    })).rejects.toThrow(/metadata must be a JSON object/);
  });

  it('rejects a malformed createdBy UUID on insert', async () => {
    await expect(upsertApiClient({
      tenantId: TENANT, clientCode: 'X', displayName: 'X', createdBy: 'not-a-uuid',
    })).rejects.toThrow(/created_by must be a UUID/);
  });

  it('defaults clientKind + status to integration/active when blank strings are passed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, client_code: 'C2' }]);
    await upsertApiClient({
      tenantId: TENANT, clientCode: 'C2', displayName: 'C2', clientKind: '', status: '',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toEqual(expect.arrayContaining(['integration', 'active']));
  });
});

// =====================================================================
// listApiClients / listApiKeys — happy paths with filters
// =====================================================================
describe('listApiClients — filtered success', () => {
  it('applies status + clientKind filters and returns rows + count', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const out = await listApiClients({ tenantId: TENANT, status: 'active', clientKind: 'partner' });
    expect(out).toEqual({ clients: [{ id: 1 }, { id: 2 }], count: 2 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/client_kind = \$3/);
  });

  it('returns rows with no optional filters', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 9 }]);
    const out = await listApiClients({ tenantId: TENANT });
    expect(out.count).toBe(1);
  });

  it('rethrows a non-schema error', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(listApiClients({ tenantId: TENANT })).rejects.toThrow('connection reset');
  });
});

describe('listApiKeys — filtered success', () => {
  it('applies apiClientId + status filters and returns rows + count', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11 }]);
    const out = await listApiKeys({ tenantId: TENANT, apiClientId: 7, status: 'active' });
    expect(out).toEqual({ keys: [{ id: 11 }], count: 1 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/api_client_id = \$2/);
    expect(sql).toMatch(/status = \$3/);
  });

  it('rethrows a non-schema error', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(listApiKeys({ tenantId: TENANT })).rejects.toThrow('timeout');
  });
});

// =====================================================================
// revokeApiKey — reason-null branch
// =====================================================================
describe('revokeApiKey — null reason', () => {
  it('revokes with a null reason (safeText null branch)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 3, status: 'revoked' }]);
    const row = await revokeApiKey({ tenantId: TENANT, id: 3 });
    expect(row.status).toBe('revoked');
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params[0]).toBeNull(); // revokedReason → null
  });
});

// =====================================================================
// issueApiKey — explicit expiresAt success path
// =====================================================================
describe('issueApiKey — with expiry', () => {
  it('accepts a valid expiresAt and forwards an ISO timestamp', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, key_prefix: 'vh_abc' }]);
    const out = await issueApiKey({
      tenantId: TENANT, apiClientId: 1, expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(out.plaintext).toMatch(/^vh_/);
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toEqual(expect.arrayContaining(['2027-01-01T00:00:00.000Z']));
  });

  it('rejects a non-positive apiClientId', async () => {
    await expect(issueApiKey({ tenantId: TENANT, apiClientId: -1 }))
      .rejects.toThrow(/api_client_id must be a positive integer/);
  });
});

// =====================================================================
// authenticateByApiKey — the IP-allowlist MATCH (success) path
// =====================================================================
describe('authenticateByApiKey — allowed IP match', () => {
  it('authenticates when the ipAddress is in allowed_ips and stamps last_used', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 2, api_client_id: 4, key_status: 'active', client_status: 'active',
      tenant_id: TENANT, client_code: 'PARTNER', display_name: 'Partner',
      client_kind: 'partner', scopes: ['fhir:read'], allowed_ips: ['10.0.0.1', '10.0.0.2'],
      rate_limit_profile: 'rl',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // last_used update

    const out = await authenticateByApiKey({ tenantId: TENANT, plaintext: 'vh_abc', ipAddress: '10.0.0.2' });

    expect(out.api_client_id).toBe(4);
    expect(out.key_id).toBe(2);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE api_keys/);
  });

  it('authenticates when allowed_ips is empty (no IP restriction)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      key_id: 1, api_client_id: 1, key_status: 'active', client_status: 'active',
      tenant_id: TENANT, scopes: [], allowed_ips: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const out = await authenticateByApiKey({ tenantId: TENANT, plaintext: 'vh_abc', ipAddress: '203.0.113.9' });
    expect(out.api_client_id).toBe(1);
  });

  it('rethrows a non-schema error from the lookup', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(authenticateByApiKey({ tenantId: TENANT, plaintext: 'vh_abc' }))
      .rejects.toThrow('deadlock detected');
  });
});
