import { jest } from '@jest/globals';

// Unit coverage for the cashier shift-close / cash-drawer reconciliation
// service (Wave-2 fix, migration 198). The service talks to Postgres only
// through prisma.$queryRawUnsafe, so a mocked prisma exercises every branch
// (validation guards, variance math, error/conflict paths) without a DB.
// Mirrors the prisma-mock convention used by billingV2Payments.test.js.

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const {
  openSession,
  closeSession,
  reviewSession,
  listSessions,
  getSession,
  VARIANCE_TOLERANCE,
} = await import('../../services/billing/cashDrawerService.js');

// Valid UUID-v4 fixtures (the requireUuid regex demands version [1-5] +
// variant [89ab]).
const TENANT = '11111111-1111-4111-8111-111111111111';
const CASHIER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  mockPrisma.$queryRawUnsafe.mockReset();
  mockPrisma.$executeRawUnsafe.mockReset();
});

describe('cashDrawerService — module config', () => {
  it('defaults VARIANCE_TOLERANCE to 1 when env is unset/non-numeric', () => {
    // CASH_DRAWER_VARIANCE_TOLERANCE is not set in the jest env, so the
    // envNumber fallback branch is taken at module load.
    expect(VARIANCE_TOLERANCE).toBe(1);
  });
});

describe('openSession', () => {
  it('inserts a session on the happy path and returns the row', async () => {
    const row = { id: 7, tenant_id: TENANT, status: 'open' };
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([row]);

    const result = await openSession({
      tenantId: TENANT,
      cashier_uid: CASHIER,
      shift: 'morning', // lower-case → normalized to MORNING
      opening_float: 500.005, // rounds to 500.01 via toFixed2
    });

    expect(result).toBe(row);
    const [sql, tid, uid, shift, floatAmount] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO cash_drawer_sessions');
    expect(tid).toBe(TENANT);
    expect(uid).toBe(CASHIER);
    expect(shift).toBe('MORNING');
    expect(floatAmount).toBe(500.01);
  });

  it('defaults opening_float to 0 when omitted', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 1 }]);
    await openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'NIGHT' });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][4]).toBe(0);
  });

  it('coerces a non-numeric opening_float to 0', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 1 }]);
    await openSession({
      tenantId: TENANT, cashier_uid: CASHIER, shift: 'GENERAL', opening_float: 'abc',
    });
    // Number('abc') is NaN → `Number(opening_float) || 0` → 0.
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][4]).toBe(0);
  });

  it('rejects a missing tenant_id', async () => {
    await expect(openSession({ cashier_uid: CASHIER, shift: 'MORNING' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'tenant_id is required' });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant_id (fails UUID regex)', async () => {
    await expect(openSession({ tenantId: 'not-a-uuid', cashier_uid: CASHIER, shift: 'MORNING' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'tenant_id must be a UUID' });
  });

  it('rejects a missing cashier_uid', async () => {
    await expect(openSession({ tenantId: TENANT, shift: 'MORNING' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'cashier_uid is required' });
  });

  it('rejects a missing shift', async () => {
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER }))
      .rejects.toMatchObject({ statusCode: 400, message: 'shift is required' });
  });

  it('rejects an invalid shift value', async () => {
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'BRUNCH' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'BRUNCH' }))
      .rejects.toThrow(/shift must be one of/);
  });

  it('rejects a negative opening_float', async () => {
    await expect(openSession({
      tenantId: TENANT, cashier_uid: CASHIER, shift: 'MORNING', opening_float: -5,
    })).rejects.toMatchObject({ statusCode: 400, message: 'opening_float cannot be negative' });
  });

  it('maps a duplicate-key violation to a 409 conflict', async () => {
    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "..."'),
    );
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'MORNING' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CASH_DRAWER_SESSION_OPEN' });
  });

  it('re-throws a non-duplicate DB error unchanged', async () => {
    const dbErr = new Error('connection reset');
    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(dbErr);
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'MORNING' }))
      .rejects.toBe(dbErr);
  });

  it('treats an error with no message as a generic re-throw (not a conflict)', async () => {
    const dbErr = new Error();
    dbErr.message = '';
    mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(dbErr);
    await expect(openSession({ tenantId: TENANT, cashier_uid: CASHIER, shift: 'MORNING' }))
      .rejects.toBe(dbErr);
  });
});

describe('closeSession', () => {
  // First $queryRawUnsafe call = SELECT the session; second = SUM system
  // total; third = UPDATE returning. Helper to wire the common shape.
  function wireOpenSession(overrides = {}) {
    return {
      id: 5,
      cashier_uid: CASHIER,
      shift: 'MORNING',
      opened_at: '2026-05-09T08:00:00.000Z',
      opening_float: 1000,
      status: 'open',
      ...overrides,
    };
  }

  it('closes within tolerance → reviewed, reviewed_by stamped, no reason needed', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession()]) // SELECT session
      .mockResolvedValueOnce([{ cash_inflow_total: '4000', cash_refund_total: '0' }])
      .mockResolvedValueOnce([{ id: 5, status: 'reviewed' }]); // UPDATE

    // counted = 5000; expected = system 4000 + float 1000 = 5000; variance 0.
    const result = await closeSession({
      tenantId: TENANT,
      id: '5',
      cashier_uid: CASHIER,
      counted_denominations: { 500: 10 }, // 500 * 10 = 5000
    });

    expect(result).toMatchObject({ id: 5, status: 'reviewed' });
    const updateArgs = mockPrisma.$queryRawUnsafe.mock.calls[2];
    const [
      updateSql, countedTotal, , cashInflowTotal, cashRefundTotal,
      systemTotal, variance, shortCount, overCount, requiresReview, reason, newStatus,
    ] = updateArgs;
    expect(updateSql).toContain('UPDATE cash_drawer_sessions');
    expect(countedTotal).toBe(5000);
    expect(cashInflowTotal).toBe(4000);
    expect(cashRefundTotal).toBe(0);
    expect(systemTotal).toBe(4000);
    expect(variance).toBe(0);
    expect(shortCount).toBe(false);
    expect(overCount).toBe(false);
    expect(requiresReview).toBe(false);
    expect(reason).toBeNull();
    expect(newStatus).toBe('reviewed');
  });

  it('reconciles signed net cash as inflow less exact linked CASH refunds', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession()])
      .mockResolvedValueOnce([{ cash_inflow_total: '4000', cash_refund_total: '750' }])
      .mockResolvedValueOnce([{
        id: 5,
        status: 'reviewed',
        cash_inflow_total: '4000.00',
        cash_refund_total: '750.00',
        system_total: '3250.00',
      }]);

    const result = await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 500: 8, 250: 1 },
    });

    expect(result).toMatchObject({
      cash_inflow_total: '4000.00',
      cash_refund_total: '750.00',
      system_total: '3250.00',
    });
    const update = mockPrisma.$queryRawUnsafe.mock.calls[2];
    expect(update.slice(3, 7)).toEqual([4000, 750, 3250, 0]);
  });

  it('over-count beyond tolerance with a reason → closed + requires_review', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([{ cash_inflow_total: '1000', cash_refund_total: '0' }])
      .mockResolvedValueOnce([{ id: 5, status: 'closed' }]);

    // counted 1500, expected 1000 → variance +500 (> tolerance 1).
    const result = await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 500: 3 },
      variance_reason: 'extra cash from float top-up',
    });

    expect(result).toMatchObject({ status: 'closed' });
    const [, , , , , , variance, shortCount, overCount, requiresReview, reason, newStatus]
      = mockPrisma.$queryRawUnsafe.mock.calls[2];
    expect(variance).toBe(500);
    expect(shortCount).toBe(false);
    expect(overCount).toBe(true);
    expect(requiresReview).toBe(true);
    expect(reason).toBe('extra cash from float top-up');
    expect(newStatus).toBe('closed');
  });

  it('short-count beyond tolerance sets short_count true', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([{ cash_inflow_total: '1000', cash_refund_total: '0' }])
      .mockResolvedValueOnce([{ id: 5, status: 'closed' }]);

    // counted 500, expected 1000 → variance -500.
    await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 500: 1 },
      variance_reason: 'till came up short',
    });
    const [, , , , , , variance, shortCount, overCount]
      = mockPrisma.$queryRawUnsafe.mock.calls[2];
    expect(variance).toBe(-500);
    expect(shortCount).toBe(true);
    expect(overCount).toBe(false);
  });

  it('truncates a very long variance_reason to 500 chars', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([{ cash_inflow_total: '0', cash_refund_total: '0' }])
      .mockResolvedValueOnce([{ id: 5, status: 'closed' }]);

    const longReason = 'x'.repeat(800);
    await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 100: 5 }, // variance +500
      variance_reason: longReason,
    });
    const reason = mockPrisma.$queryRawUnsafe.mock.calls[2][10];
    expect(reason).toHaveLength(500);
  });

  it('requires a variance_reason when |variance| exceeds tolerance', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([{ cash_inflow_total: '0', cash_refund_total: '0' }]);

    await expect(closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 500: 1 }, // variance +500, no reason
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_DRAWER_VARIANCE_REASON_REQUIRED',
      details: { variance: 500, tolerance: VARIANCE_TOLERANCE },
    });
    // It must not reach the UPDATE.
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('defaults systemTotal to 0 when the SUM row is missing', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([]) // no system row → systemRow?.system_total undefined
      .mockResolvedValueOnce([{ id: 5, status: 'reviewed' }]);

    // counted 0, expected 0 → variance 0 → within tolerance.
    await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: {},
    });
    const [, countedTotal, , cashInflowTotal, cashRefundTotal, systemTotal, variance]
      = mockPrisma.$queryRawUnsafe.mock.calls[2];
    expect(countedTotal).toBe(0);
    expect(cashInflowTotal).toBe(0);
    expect(cashRefundTotal).toBe(0);
    expect(systemTotal).toBe(0);
    expect(variance).toBe(0);
  });

  it('serializes null denominations to an empty-object jsonb param', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession({ opening_float: 0 })])
      .mockResolvedValueOnce([{ cash_inflow_total: '0', cash_refund_total: '0' }])
      .mockResolvedValueOnce([{ id: 5, status: 'reviewed' }]);

    await closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: null, // sum → 0, JSON.stringify(null||{}) → "{}"
    });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[2][2]).toBe('{}');
  });

  it('rejects a non-existent session with 404', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // SELECT → no row
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: {},
    })).rejects.toMatchObject({ statusCode: 404, message: 'Cash-drawer session not found' });
  });

  it('forbids a different cashier from closing the session', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: OTHER, counted_denominations: {},
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects closing a session that is not open', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession({ status: 'closed' })]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: {},
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CASH_DRAWER_SESSION_NOT_OPEN',
    });
  });

  it('rejects a non-positive / non-numeric session id', async () => {
    await expect(closeSession({
      tenantId: TENANT, id: '0', cashier_uid: CASHIER, counted_denominations: {},
    })).rejects.toMatchObject({ statusCode: 400, message: 'session id must be a positive integer' });
    await expect(closeSession({
      tenantId: TENANT, id: 'abc', cashier_uid: CASHIER, counted_denominations: {},
    })).rejects.toMatchObject({ statusCode: 400 });
    // Neither bad-id call should touch the DB.
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('raises an optimistic-lock conflict when the UPDATE returns no row', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession()])
      .mockResolvedValueOnce([{ cash_inflow_total: '4000', cash_refund_total: '0' }])
      .mockResolvedValueOnce([]); // UPDATE matched nothing (status changed)

    await expect(closeSession({
      tenantId: TENANT,
      id: 5,
      cashier_uid: CASHIER,
      counted_denominations: { 500: 10 }, // variance 0 → within tolerance
    })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Session state changed; reload and retry',
    });
  });

  it('rejects denominations that are not a plain object', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: [500, 100],
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'counted_denominations must be a JSON object of { denomination: count }',
    });
  });

  it('rejects an invalid denomination face value', async () => {
    // Two assertions → two closeSession calls → two SELECTs to satisfy.
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([wireOpenSession()])
      .mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: { '-5': 2 },
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: { '-5': 2 },
    })).rejects.toThrow(/Invalid denomination face value/);
  });

  it('rejects a non-numeric denomination face value', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: { abc: 2 },
    })).rejects.toThrow(/Invalid denomination face value/);
  });

  it('rejects a negative note/coin count', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: { 100: -1 },
    })).rejects.toThrow(/Invalid note\/coin count/);
  });

  it('rejects a non-integer note/coin count', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([wireOpenSession()]);
    await expect(closeSession({
      tenantId: TENANT, id: 5, cashier_uid: CASHIER, counted_denominations: { 100: 1.5 },
    })).rejects.toThrow(/Invalid note\/coin count/);
  });
});

describe('reviewSession', () => {
  it('marks a closed session reviewed on the happy path', async () => {
    const row = { id: 9, status: 'reviewed' };
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([row]);

    const result = await reviewSession({
      tenantId: TENANT,
      id: '9',
      reviewer_uid: REVIEWER,
      review_notes: 'variance explained by float miscount',
    });

    expect(result).toBe(row);
    const [sql, reviewerUid, notes, sessionId, tid] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('UPDATE cash_drawer_sessions');
    expect(sql).toContain("status = 'reviewed'");
    expect(reviewerUid).toBe(REVIEWER);
    expect(notes).toBe('variance explained by float miscount');
    expect(sessionId).toBe(9);
    expect(tid).toBe(TENANT);
  });

  it('passes null notes when review_notes omitted and truncates long notes', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 9 }]);
    await reviewSession({ tenantId: TENANT, id: 9, reviewer_uid: REVIEWER });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][2]).toBeNull();

    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 9 }]);
    await reviewSession({
      tenantId: TENANT, id: 9, reviewer_uid: REVIEWER, review_notes: 'y'.repeat(900),
    });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[1][2]).toHaveLength(500);
  });

  it('rejects a bad session id', async () => {
    await expect(reviewSession({ tenantId: TENANT, id: '0', reviewer_uid: REVIEWER }))
      .rejects.toMatchObject({ statusCode: 400, message: 'session id must be a positive integer' });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a missing reviewer_uid', async () => {
    await expect(reviewSession({ tenantId: TENANT, id: 9 }))
      .rejects.toMatchObject({ statusCode: 400, message: 'reviewer_uid is required' });
  });

  it('404s when no closed session matches', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // UPDATE … status='closed' matched nothing
    await expect(reviewSession({ tenantId: TENANT, id: 9, reviewer_uid: REVIEWER }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Session not found or not in closed state' });
  });
});

describe('listSessions', () => {
  it('lists with only the tenant filter and default limit', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(rows);

    const result = await listSessions({ tenantId: TENANT });

    expect(result).toBe(rows);
    const args = mockPrisma.$queryRawUnsafe.mock.calls[0];
    const sql = args[0];
    expect(sql).toContain('FROM cash_drawer_sessions');
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain('ORDER BY opened_at DESC');
    // params: [tid, limit]
    expect(args[1]).toBe(TENANT);
    expect(args[2]).toBe(100);
  });

  it('applies every optional filter together', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);

    await listSessions({
      tenantId: TENANT,
      cashier_uid: CASHIER,
      shift: 'evening',
      status: 'OPEN',
      requires_review: true,
      limit: 25,
    });

    const args = mockPrisma.$queryRawUnsafe.mock.calls[0];
    const sql = args[0];
    expect(sql).toContain('cashier_uid = $2::uuid');
    expect(sql).toContain('shift = $3');
    expect(sql).toContain('status = $4');
    expect(sql).toContain('requires_review = $5');
    // params: tid, cashier, EVENING, open, true, limit
    expect(args.slice(1)).toEqual([TENANT, CASHIER, 'EVENING', 'open', true, 25]);
  });

  it('coerces string/numeric truthy requires_review values to boolean true', async () => {
    for (const truthy of ['true', 1, '1', true]) {
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await listSessions({ tenantId: TENANT, requires_review: truthy });
      const args = mockPrisma.$queryRawUnsafe.mock.calls.at(-1);
      // params: [tid, requires_review, limit]
      expect(args[2]).toBe(true);
    }
  });

  it('coerces other requires_review values to boolean false', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await listSessions({ tenantId: TENANT, requires_review: false });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0][2]).toBe(false);
  });

  it('ignores requires_review when null (no filter added)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await listSessions({ tenantId: TENANT, requires_review: null });
    const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
    expect(sql).not.toContain('requires_review =');
  });

  it('rejects an invalid status filter', async () => {
    await expect(listSessions({ tenantId: TENANT, status: 'archived' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'status must be one of open, closed, reviewed' });
  });

  it('clamps the limit to the [1, 500] range', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await listSessions({ tenantId: TENANT, limit: 99999 });
    expect(mockPrisma.$queryRawUnsafe.mock.calls[0].at(-1)).toBe(500);

    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await listSessions({ tenantId: TENANT, limit: -10 });
    // Math.max(parseInt('-10') || 100 → -10, 1) → 1
    expect(mockPrisma.$queryRawUnsafe.mock.calls[1].at(-1)).toBe(1);

    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await listSessions({ tenantId: TENANT, limit: 'notanumber' });
    // parseInt fails → || 100 fallback
    expect(mockPrisma.$queryRawUnsafe.mock.calls[2].at(-1)).toBe(100);
  });

  it('rejects a malformed cashier_uid filter', async () => {
    await expect(listSessions({ tenantId: TENANT, cashier_uid: 'nope' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'cashier_uid must be a UUID' });
  });

  it('rejects an invalid shift filter', async () => {
    await expect(listSessions({ tenantId: TENANT, shift: 'teatime' }))
      .rejects.toThrow(/shift must be one of/);
  });
});

describe('getSession', () => {
  it('returns the session row on the happy path', async () => {
    const row = { id: 3, status: 'open' };
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([row]);

    const result = await getSession({ tenantId: TENANT, id: '3' });

    expect(result).toBe(row);
    const [sql, sessionId, tid] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('FROM cash_drawer_sessions');
    expect(sessionId).toBe(3);
    expect(tid).toBe(TENANT);
  });

  it('rejects a bad session id', async () => {
    await expect(getSession({ tenantId: TENANT, id: 'xyz' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'session id must be a positive integer' });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a missing tenant id', async () => {
    await expect(getSession({ id: 3 }))
      .rejects.toMatchObject({ statusCode: 400, message: 'tenant_id is required' });
  });

  it('404s when the session does not exist', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(getSession({ tenantId: TENANT, id: 3 }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Cash-drawer session not found' });
  });
});
