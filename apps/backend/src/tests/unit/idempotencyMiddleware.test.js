/**
 * Phase E4 — idempotencyMiddleware unit tests.
 * Covers: missing-required header → 400, replay → cached response,
 * in_flight → 409, mismatch → 422, normal claim → handler runs and
 * response is captured.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const { requireIdempotencyKey } = await import('../../middleware/idempotencyMiddleware.js');

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function makeReqRes(overrides = {}) {
  const headers = overrides.headers || {};
  const req = {
    method: 'POST',
    originalUrl: '/api/v1/billing/invoice',
    body: overrides.body || { x: 1 },
    tenantId: '00000000-0000-4000-8000-000000000001',
    user: { uid: '11111111-1111-4111-8111-111111111111' },
    get(name) { return headers[name.toLowerCase()] || null; },
    ...overrides,
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

describe('requireIdempotencyKey', () => {
  it('returns 400 when header missing and required:true', async () => {
    const mw = requireIdempotencyKey({ required: true, scope: 'invoice' });
    const { req, res } = makeReqRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key/);
  });

  it('passes through when header missing and required:false', async () => {
    const mw = requireIdempotencyKey({ required: false, scope: 'invoice' });
    const { req, res } = makeReqRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects malformed header value with 400', async () => {
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'has spaces' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('returns the cached response on replay', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'complete', response_status: 201,
      response_body: { ok: true, id: 42 }, request_body_hash: null,
    }]);
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, id: 42 });
  });

  it('returns 409 when in_flight', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'in_flight', request_body_hash: null,
    }]);
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
  });

  it('returns 422 on body mismatch', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'complete', response_status: 201,
      response_body: {}, request_body_hash: 'OTHER',
    }]);
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
  });

  it('proceeds to handler on first claim, captures response, persists complete', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99, status: 'in_flight' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99, status: 'complete' }]);
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn(() => {
      res.status(201).json({ created: true });
    });
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ created: true });
    // Allow async finaliseIdempotencyKey to resolve.
    await new Promise((r) => setImmediate(r));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE idempotency_keys/);
  });

  it('falls through on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
