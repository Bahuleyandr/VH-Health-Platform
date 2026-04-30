/**
 * Phase E4 — idempotencyService unit tests.
 * Covers claim states (claimed / replay / in_flight / mismatch),
 * schema-missing fail-open, and finalisation.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  claimIdempotencyKey,
  expireOldIdempotencyKeys,
  finaliseIdempotencyKey,
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
  });

  it('returns replay on duplicate complete row with matching body hash', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
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
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
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
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
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

  it('fails open on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    const out = await claimIdempotencyKey({
      tenantId: TENANT, userUid: USER, requestKey: 'k1',
      requestMethod: 'POST', requestPath: '/x', requestBodyHash: null,
    });
    expect(out.state).toBe('claimed');
    expect(out.schemaMissing).toBe(true);
    expect(out.id).toBeNull();
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
});

describe('expireOldIdempotencyKeys', () => {
  it('returns count of expired rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const out = await expireOldIdempotencyKeys();
    expect(out.expired).toBe(3);
  });
  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    expect(await expireOldIdempotencyKeys()).toEqual({ expired: 0 });
  });
});
