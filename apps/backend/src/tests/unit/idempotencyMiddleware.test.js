/**
 * Phase E4 — idempotencyMiddleware unit tests.
 * Covers: missing-required header → 400, replay → cached response,
 * in_flight → 409, mismatch → 422, normal claim → handler runs and
 * response is captured.
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

const { requireIdempotencyKey } = await import('../../middleware/idempotencyMiddleware.js');
const { hashRequestBody } = await import('../../services/idempotency/idempotencyService.js');

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
  it('requires a durable domain receipt before completed replays may re-enter a handler', () => {
    expect(() => requireIdempotencyKey({
      revalidateCompletedReplay: true,
    })).toThrow(/durable domain receipt/i);
  });

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

  it('re-enters a durable handler for a completed replay that requires current authority', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 17,
      status: 'complete',
      response_status: 200,
      response_body: { idempotent_replay: false },
      request_body_hash: hashRequestBody({ x: 1 }),
    }]);
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'pharmacy_inventory_disposal',
      durableDomainReceipt: true,
      revalidateCompletedReplay: true,
    });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'disposal-key' } });
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
    expect(req.idempotencyClaim).toEqual(expect.objectContaining({
      id: 17,
      requestKey: 'disposal-key',
      scope: 'pharmacy_inventory_disposal',
      completedReplay: true,
    }));
  });

  it('keeps cached failure semantics when successful receipt revalidation is enabled', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 18,
      status: 'failed',
      response_status: 409,
      response_body: { code: 'DISPOSAL_AUTHORITY_INVALID' },
      request_body_hash: hashRequestBody({ x: 1 }),
    }]);
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'pharmacy_inventory_disposal',
      durableDomainReceipt: true,
      revalidateCompletedReplay: true,
    });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'failed-disposal-key' } });
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ code: 'DISPOSAL_AUTHORITY_INVALID' });
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

  it.each([
    {
      name: 'replay',
      row: {
        id: 1,
        status: 'complete',
        response_status: 201,
        response_body: { ok: true },
        request_body_hash: hashRequestBody({ x: 1 }),
        is_expired: false,
      },
      statusCode: 201,
      body: { ok: true },
    },
    {
      name: 'in-flight rejection',
      row: {
        id: 1,
        status: 'in_flight',
        request_body_hash: hashRequestBody({ x: 1 }),
        is_expired: false,
      },
      statusCode: 409,
    },
    {
      name: 'body mismatch',
      row: {
        id: 1,
        status: 'complete',
        response_status: 201,
        response_body: { ok: true },
        request_body_hash: hashRequestBody({ x: 2 }),
        is_expired: false,
      },
      statusCode: 422,
    },
  ])('collapses an alias onto one canonical claim for $name', async ({ row, statusCode, body }) => {
    queryUnsafeMock
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
      .mockResolvedValueOnce([row]);
    const canonicalPath = '/api/v1/pharmacy-orders/inventory/v2/disposals';
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'pharmacy_inventory_disposal',
      requestPathForIdempotency: canonicalPath,
    });
    const { req, res } = makeReqRes({
      originalUrl: '/api/v1/pharmacy/inventory/v2/disposals?source=alias',
      headers: { 'idempotency-key': 'cross-alias-key' },
      body: { x: 1 },
    });
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(statusCode);
    if (body) expect(res.body).toEqual(body);
    expect(queryUnsafeMock.mock.calls[0][5]).toBe(canonicalPath);
    expect(queryUnsafeMock.mock.calls[1][4]).toBe(canonicalPath);
  });

  it('derives canonical approval paths without conflating distinct approval ids', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 71, status: 'in_flight' }])
      .mockResolvedValueOnce([{ id: 72, status: 'in_flight' }]);
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'pharmacy_inventory_disposal_witness_approval',
      requestPathForIdempotency: (req) => (
        `/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/${req.params.id}/approve`
      ),
    });
    const first = makeReqRes({
      originalUrl: '/api/v1/pharmacy/inventory/v2/disposals/witness-approvals/71/approve',
      params: { id: '71' },
      headers: { 'idempotency-key': 'approval-key' },
    });
    const second = makeReqRes({
      originalUrl: '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/72/approve',
      params: { id: '72' },
      headers: { 'idempotency-key': 'approval-key' },
    });
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    await mw(first.req, first.res, firstNext);
    await mw(second.req, second.res, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][5]).toBe(
      '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/71/approve',
    );
    expect(queryUnsafeMock.mock.calls[1][5]).toBe(
      '/api/v1/pharmacy-orders/inventory/v2/disposals/witness-approvals/72/approve',
    );
  });

  it.each(['complete', 'cancel', 'discontinue'])(
    'replays the committed %s terminal response before the handler can re-run',
    async (action) => {
      const terminalBody = {
        action,
        reason: action === 'complete' ? null : 'Therapy no longer indicated',
      };
      queryUnsafeMock
        .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
        .mockResolvedValueOnce([{
          id: 91,
          status: 'complete',
          response_status: 200,
          response_body: { success: true, data: { id: 47, status: `${action}d` } },
          request_body_hash: hashRequestBody(terminalBody),
          is_expired: false,
        }]);
      const mw = requireIdempotencyKey({
        required: true,
        scope: 'clinical_order_terminal',
        retainOnServerError: true,
        requestPathForIdempotency: (req) => (
          `/api/v1/emr/orders/${Number(req.params.id)}/terminal`
        ),
        requestBodyForIdempotency: (req) => ({
          action,
          reason: String(req.body?.reason || '').trim() || null,
        }),
      });
      const { req, res } = makeReqRes({
        method: 'PUT',
        originalUrl: `/emr/orders/47/${action}?client=staff`,
        params: { id: '47' },
        headers: { 'idempotency-key': `terminal-${action}-47` },
        body: { reason: terminalBody.reason },
      });
      const next = jest.fn();

      await mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({ id: 47 });
      expect(queryUnsafeMock.mock.calls[0][5]).toBe('/api/v1/emr/orders/47/terminal');
      expect(queryUnsafeMock.mock.calls[0][6]).toBe(hashRequestBody(terminalBody));
    },
  );

  it('rejects reuse of a terminal key for a different terminal action', async () => {
    queryUnsafeMock
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
      .mockResolvedValueOnce([{
        id: 92,
        status: 'complete',
        response_status: 200,
        response_body: { success: true },
        request_body_hash: hashRequestBody({ action: 'complete', reason: null }),
        is_expired: false,
      }]);
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'clinical_order_terminal',
      requestPathForIdempotency: (req) => (
        `/api/v1/emr/orders/${Number(req.params.id)}/terminal`
      ),
      requestBodyForIdempotency: () => ({
        action: 'cancel',
        reason: 'Entered in error',
      }),
    });
    const { req, res } = makeReqRes({
      method: 'PUT',
      originalUrl: '/api/v1/emr/orders/47/cancel',
      params: { id: '47' },
      headers: { 'idempotency-key': 'terminal-action-conflict-47' },
      body: { reason: 'Entered in error' },
    });
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
  });

  it('releases a recoverable terminal conflict so the same key can resume', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 93, status: 'in_flight' }])
      .mockResolvedValueOnce([{ id: 93 }]);
    const mw = requireIdempotencyKey({
      required: true,
      scope: 'clinical_order_terminal',
      retainOnServerError: true,
      releaseOnResponseCodes: [
        'MAR_ORDER_TERMINAL_EXCEPTION_NOTIFICATION_IN_FLIGHT',
      ],
    });
    const { req, res } = makeReqRes({
      method: 'PUT',
      headers: { 'idempotency-key': 'terminal-reconcile-47' },
    });
    const next = jest.fn(() => {
      res.status(409).json({
        success: false,
        code: 'MAR_ORDER_TERMINAL_EXCEPTION_NOTIFICATION_IN_FLIGHT',
      });
    });

    await mw(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/DELETE FROM idempotency_keys/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/status = 'in_flight'/);
    expect(queryUnsafeMock.mock.calls[1][1]).toBe(93);
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

  it('hashes only the route-selected non-secret witness approval fields', async () => {
    async function claimedHash(body) {
      queryUnsafeMock.mockResolvedValueOnce([{ id: 99, status: 'in_flight' }]);
      const mw = requireIdempotencyKey({
        required: true,
        scope: 'pharmacy_counter_sale_witness_approval',
        requestBodyForIdempotency: (req) => ({
          employeeId: req.body.employeeId,
          sale: req.body.sale,
        }),
      });
      const { req, res } = makeReqRes({
        headers: { 'idempotency-key': 'witness-approval-key' },
        body,
      });
      await mw(req, res, jest.fn());
      const hash = queryUnsafeMock.mock.calls.at(-1)[6];
      expect(req.body.password).toBe(body.password);
      return hash;
    }

    const sale = { lines: [{ inventory_item_id: 17, quantity: 1 }] };
    const firstHash = await claimedHash({
      employeeId: 'NURSE-002',
      password: 'first-witness-secret',
      sale,
    });
    const changedPasswordHash = await claimedHash({
      employeeId: 'NURSE-002',
      password: 'different-witness-secret',
      sale,
    });
    const changedEmployeeHash = await claimedHash({
      employeeId: 'NURSE-003',
      password: 'first-witness-secret',
      sale,
    });

    expect(firstHash).toBe(hashRequestBody({ employeeId: 'NURSE-002', sale }));
    expect(firstHash).not.toBe(hashRequestBody({
      employeeId: 'NURSE-002',
      password: 'first-witness-secret',
      sale,
    }));
    expect(changedPasswordHash).toBe(firstHash);
    expect(changedEmployeeHash).not.toBe(firstHash);
  });

  it('falls through on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    const mw = requireIdempotencyKey({ required: false });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // DELTA-001: required routes must FAIL CLOSED when the store is unavailable.
  it('DELTA-001: required route rejects (503) when the claim errors', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const mw = requireIdempotencyKey({ required: true, scope: 'orders' });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it('DELTA-001: required route rejects (503) on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "idempotency_keys" does not exist'));
    const mw = requireIdempotencyKey({ required: true, scope: 'orders' });
    const { req, res } = makeReqRes({ headers: { 'idempotency-key': 'k1' } });
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });
});
