/**
 * Phase E4 — idempotencyService unit tests.
 * Covers claim states (claimed / replay / in_flight / mismatch),
 * schema-missing fail-closed behavior, and finalisation.
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
  claimIdempotencyKey,
  expireOldIdempotencyKeys,
  finaliseIdempotencyKey,
  releaseIdempotencyKey,
  hashRequestBody,
  isValidIdempotencyKey,
} = await import('../../services/idempotency/idempotencyService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('isValidIdempotencyKey', () => {
  it('accepts conventional Stripe-shaped keys', () => {
    expect(isValidIdempotencyKey('a1b2c3-d4-e5f6')).toBe(true);
    expect(isValidIdempotencyKey('payment.2026-04-30.req-42')).toBe(true);
  });
  it('rejects empty / overlong / weird keys', () => {
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(201))).toBe(false);
    expect(isValidIdempotencyKey('has whitespace')).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
  });
});

describe('hashRequestBody', () => {
  it('produces a stable hex digest', () => {
    const a = hashRequestBody({ a: 1, b: 2 });
    const b = hashRequestBody({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns null for null/undefined', () => {
    expect(hashRequestBody(null)).toBeNull();
    expect(hashRequestBody(undefined)).toBeNull();
  });
});

describe('claimIdempotencyKey', () => {
  it('rejects malformed keys', async () => {
    await expect(claimIdempotencyKey({
      tenantId: TENANT, userUid: USER,
      requestKey: 'has whitespace', requestMethod: 'POST',
      requestPath: '/billing/invoice', requestBodyHash: 'abc',
    })).rejects.toThrow(/Idempotency-Key/);
  });

  it('returns claimed on first call', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_flight' }]);
    const out = await claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/billing/invoice',
      requestBodyHash: 'abc',
    });
    expect(out.state).toBe('claimed');
    expect(out.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
  });

  it('returns replay on duplicate complete row with matching body hash', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'complete', response_status: 201,
      response_body: { ok: true, id: 99 }, request_body_hash: 'abc',
    }]);
    const out = await claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'abc',
    });
    expect(out.state).toBe('replay');
    expect(out.response_status).toBe(201);
    expect(out.response_body.id).toBe(99);
  });

  it('returns in_flight when a concurrent retry is mid-execution', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'in_flight', request_body_hash: 'abc',
    }]);
    const out = await claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'abc',
    });
    expect(out.state).toBe('in_flight');
  });

  it('returns mismatch when the same key is reused with a different body', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'complete', response_status: 201,
      response_body: {}, request_body_hash: 'abc',
    }]);
    const out = await claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'DIFFERENT',
    });
    expect(out.state).toBe('mismatch');
  });

  it('CAS-reclaims an expired row with the exact request body', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 7,
        status: 'expired',
        response_status: 201,
        response_body: { stale: true },
        request_body_hash: 'abc',
        is_expired: true,
      }])
      .mockResolvedValueOnce([{ id: 7 }]);

    await expect(claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'expired-exact',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'abc',
    })).resolves.toEqual({ state: 'claimed', id: 7 });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[2][0]).toContain(
      "status IN ('complete', 'failed', 'expired')",
    );
    expect(queryUnsafeMock.mock.calls[2].slice(1)).toEqual([7, 'abc', '24']);
  });

  it('preserves body mismatch semantics for an expired row', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 8,
        status: 'expired',
        response_status: 201,
        response_body: { stale: true },
        request_body_hash: 'abc',
        is_expired: true,
      }]);

    await expect(claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'expired-mismatch',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'different',
    })).resolves.toEqual({ state: 'mismatch' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => (
      sql.startsWith('UPDATE idempotency_keys')
    ))).toBe(false);
  });

  it('allows exactly one of two concurrent retries to reclaim an expired row', async () => {
    let reclaimAttempts = 0;
    queryUnsafeMock.mockImplementation(async (sql) => {
      if (sql.startsWith('INSERT INTO idempotency_keys')) {
        return [];
      }
      if (sql.includes('SELECT id, status, response_status')) {
        return [{
          id: 9,
          status: 'expired',
          response_status: 201,
          response_body: { stale: true },
          request_body_hash: 'abc',
          is_expired: true,
        }];
      }
      if (sql.startsWith('UPDATE idempotency_keys')) {
        reclaimAttempts += 1;
        return reclaimAttempts === 1 ? [{ id: 9 }] : [];
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const command = {
      tenantId: TENANT, userUid: USER, requestKey: 'expired-race',
      requestMethod: 'POST', requestPath: '/billing/invoice', requestBodyHash: 'abc',
    };
    const results = await Promise.all([
      claimIdempotencyKey(command),
      claimIdempotencyKey(command),
    ]);

    expect(results).toEqual(expect.arrayContaining([
      { state: 'claimed', id: 9 },
      { state: 'in_flight' },
    ]));
    expect(reclaimAttempts).toBe(2);
  });

  it('fails closed on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    await expect(claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/x', requestBodyHash: null,
    })).rejects.toThrow('idempotency_keys');
  });
});

describe('finaliseIdempotencyKey', () => {
  it('persists complete + status + body', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'complete' }]);
    const row = await finaliseIdempotencyKey({
      id: 1, status: 'complete', responseStatus: 201, responseBody: { x: 1 },
    });
    expect(row.status).toBe('complete');
  });
  it('downgrades unknown status to complete vs failed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'complete' }]);
    await finaliseIdempotencyKey({ id: 1, status: 'pending', responseStatus: 200 });
    expect(queryUnsafeMock.mock.calls[0][1]).toBe('complete');
  });
  it('returns null and skips DB call when id is null', async () => {
    expect(await finaliseIdempotencyKey({ id: null })).toBeNull();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
  it('propagates schema failure while finalising a real claim', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    await expect(finaliseIdempotencyKey({ id: 1, responseStatus: 201 }))
      .rejects.toThrow('idempotency_keys');
  });
  it('propagates schema failure while releasing a real claim', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    await expect(releaseIdempotencyKey(1)).rejects.toThrow('idempotency_keys');
  });
});

describe('expireOldIdempotencyKeys', () => {
  it('returns count of expired rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const out = await expireOldIdempotencyKeys();
    expect(out.expired).toBe(3);
  });
  it('reports schema-missing as a failed sweep', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    await expect(expireOldIdempotencyKeys()).rejects.toThrow('idempotency_keys');
  });
});
