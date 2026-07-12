/**
 * Audit §3 (PHI/audit) fail-safe regression — auditLogMiddleware queue-full path.
 *
 * The universal audit middleware fires the DB write from a bounded queue
 * (MAX_PENDING_AUDIT_LOGS = 1000). Before this fix, when the queue was full
 * the entry was DROPPED with only a warning that was not written to error.log
 * and NO durable file fallback — violating the "audit never lost" guarantee
 * (the DB-error path already file-falls-back; the queue-full path did not).
 *
 * This test saturates the queue by holding every DB write pending, then drives
 * one more request across the threshold and asserts the queue-full drop is
 * written to the Winston file fallback (same sink the DB-error path uses),
 * carrying enough of the entry to reconstruct it (action / path / method /
 * userId), and that the request is never blocked.
 *
 * Pure unit test: prisma + logger fully mocked, no DB. Fake req/res
 * (EventEmitter) so we can cheaply saturate the in-memory queue.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();
const errorMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    error: errorMock,
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { auditLogMiddleware } = await import('../../middleware/auditLog.js');

const ACTOR_UID = '11111111-1111-4111-8111-111111111111';

function makeReqRes(i) {
  const req = {
    id: `req-${i}`,
    method: 'POST',
    originalUrl: `/api/v1/appointments/${i}/confirm`,
    path: `/api/v1/appointments/${i}/confirm`,
    query: {},
    body: { note: 'x' },
    ip: '10.0.0.10',
    headers: { 'user-agent': 'jest' },
    user: { id: 70 + i, uid: ACTOR_UID, role: 'RECEPTIONIST' },
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();
});

describe('auditLogMiddleware queue-full durability', () => {
  it('writes the dropped entry to the Winston file fallback when the queue is full (never silently lost)', async () => {
    // Hold every DB write pending so the bounded counter saturates and never
    // drains while we push requests through.
    queryRawUnsafeMock.mockReturnValue(new Promise(() => {}));

    const next = jest.fn();

    // Fill the queue right up to MAX_PENDING_AUDIT_LOGS (1000). Each finished
    // request increments the counter (the write never resolves, so it never
    // decrements).
    for (let i = 0; i < 1000; i += 1) {
      const { req, res } = makeReqRes(i);
      auditLogMiddleware(req, res, next);
      res.emit('finish');
    }

    // Let the queued setImmediate callbacks run (they will hang on the pending
    // DB write, keeping the counter pinned at the max).
    await new Promise((resolve) => setImmediate(resolve));

    // No queue-full alarm yet — we are exactly AT capacity, not over.
    const dropErrorsBefore = errorMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('queue full'),
    );
    expect(dropErrorsBefore).toHaveLength(0);

    // The 1001st request must be dropped — and MUST hit the file fallback.
    const { req: lastReq, res: lastRes } = makeReqRes(9999);
    auditLogMiddleware(lastReq, lastRes, next);
    lastRes.emit('finish');

    // The drop happens synchronously inside res.on('finish'); the file
    // fallback is invoked on that same tick.
    const dropCalls = errorMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].toLowerCase().includes('queue full'),
    );
    expect(dropCalls.length).toBeGreaterThanOrEqual(1);

    // The fallback must carry enough of the entry to reconstruct it — not just
    // a bare "queue full" string.
    const payload = dropCalls[dropCalls.length - 1][1];
    expect(payload).toBeDefined();
    expect(payload).toEqual(
      expect.objectContaining({
        action: 'confirm_appointment',
        path: '/api/v1/appointments/9999/confirm',
        method: 'POST',
      }),
    );

    // Request flow is never blocked by audit backpressure.
    expect(next).toHaveBeenCalled();
  });
});
