import { jest } from '@jest/globals';

// PR #889 shard 1/3 lost `notification-delivery-recovery.deep.test.js` to
// `Raw query failed. Code: 40001` escaping notificationOutbox.claimPendingBatch.
// The claim runs at SERIALIZABLE, so Postgres aborting one of two concurrent
// claimers is the contract working — 40001 is retryable by that same contract,
// and letting it reach the caller turns a routine lost race into a 500.
//
// The deep suite proves the end-to-end behaviour against a real database. This
// pins the two things a database test cannot show cheaply: that the retry is
// bounded and refuses non-transient errors, and that the SQLSTATE is read from
// the exact places Prisma surfaces it. That second one is the quiet one — a
// Prisma upgrade that moves `meta.driverAdapterError.cause.originalCode` would
// silently disable the retry in production with every suite still green.

const TENANT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
const setTenantTxMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => null,
  runInTenantContext: async (_t, fn) => fn(),
}));

const { notificationOutbox } = await import('../../utils/notifications/notificationOutbox.js');

// The three shapes Prisma can hand back the same SQLSTATE in.
function knownRequestError(code) {
  return Object.assign(new Error('Raw query failed.'), { meta: { code } });
}
function driverAdapterError(originalCode) {
  return Object.assign(new Error('Raw query failed.'), {
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

const CLAIMED_ROW = { id: 7, claim_token: 'token', claim_generation: 1 };

beforeEach(() => {
  setTenantTxMock.mockReset();
  loggerMock.warn.mockReset();
});

describe('claimPendingBatch serializable retry', () => {
  test('retries a 40001 and returns the claim the next attempt wins', async () => {
    setTenantTxMock
      .mockRejectedValueOnce(knownRequestError('40001'))
      .mockResolvedValueOnce([CLAIMED_ROW]);

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .resolves.toEqual([CLAIMED_ROW]);
    expect(setTenantTxMock).toHaveBeenCalledTimes(2);
  });

  test('every retry runs at SERIALIZABLE — the isolation level is never downgraded', async () => {
    setTenantTxMock
      .mockRejectedValueOnce(knownRequestError('40001'))
      .mockResolvedValueOnce([]);

    await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID });

    for (const call of setTenantTxMock.mock.calls) {
      expect(call[2]).toMatchObject({ isolationLevel: 'Serializable' });
    }
  });

  test('reads the SQLSTATE from the Prisma 7 driver-adapter nesting', async () => {
    setTenantTxMock
      .mockRejectedValueOnce(driverAdapterError('40001'))
      .mockResolvedValueOnce([CLAIMED_ROW]);

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .resolves.toEqual([CLAIMED_ROW]);
    expect(setTenantTxMock).toHaveBeenCalledTimes(2);
  });

  test('retries a 40P01 deadlock on the same contract', async () => {
    setTenantTxMock
      .mockRejectedValueOnce(driverAdapterError('40P01'))
      .mockResolvedValueOnce([]);

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .resolves.toEqual([]);
    expect(setTenantTxMock).toHaveBeenCalledTimes(2);
  });

  test('is bounded — a permanently conflicted claim rethrows after 3 attempts', async () => {
    setTenantTxMock.mockRejectedValue(knownRequestError('40001'));

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ meta: { code: '40001' } });
    expect(setTenantTxMock).toHaveBeenCalledTimes(3);
  });

  test('does NOT retry a non-transient error — it surfaces on the first attempt', async () => {
    setTenantTxMock.mockRejectedValue(knownRequestError('42P01'));

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ meta: { code: '42P01' } });
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry a unique violation — queueTx absorbs the expected one', async () => {
    setTenantTxMock.mockRejectedValue(knownRequestError('23505'));

    await expect(notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ meta: { code: '23505' } });
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });

  test('logs one warning per retry, carrying the SQLSTATE and no recipient data', async () => {
    setTenantTxMock
      .mockRejectedValueOnce(knownRequestError('40001'))
      .mockResolvedValueOnce([]);

    await notificationOutbox.claimPendingBatch({ tenantId: TENANT_ID });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [message, context] = loggerMock.warn.mock.calls[0];
    expect(message).toContain('serializable conflict');
    expect(context).toMatchObject({
      operation: 'claimPendingBatch',
      tenant_id: TENANT_ID,
      attempt: 1,
      max_attempts: 3,
      sql_state: '40001',
    });
  });
});
