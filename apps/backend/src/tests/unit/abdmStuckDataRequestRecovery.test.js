import { jest } from '@jest/globals';

// Audit BE-M7: when processing a consent-bound HIE data request failed, the
// FAILED-status marker write was itself fire-and-forget (`.catch(() => {})`),
// so a DB failure left the request 'PROCESSING' forever with no signal.
// These tests pin the fixed contract: the marker is awaited with a bounded
// retry, retry exhaustion logs loudly (never throws — the callback response
// was already sent), and the cron sweep marks stale PROCESSING rows FAILED
// with the pre-RLS house tenant predicate on every query.

const TENANT = '00000000-0000-4000-8000-000000000001';

const queryRawUnsafeMock = jest.fn();
const setTenantQueryMock = jest.fn();
const loggerError = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};
const __tenantTx = {
  $queryRawUnsafe: setTenantQueryMock,
};
const setTenantMock = jest.fn(async (_tenantId, fn) => fn(__tenantTx));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: setTenantMock,
  setTenantTx: setTenantMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: loggerError, debug: jest.fn() },
}));

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: false,
    bridgeUrl: 'https://bridge.example',
    gatewayUrl: 'https://gateway.example',
    hipId: 'HIP-1',
    hipName: 'VH Health',
  },
}));

jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: {},
}));

const abdmService = (await import('../../services/abdm/abdmService.js')).default;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('abdmService._markDataRequestFailed (BE-M7)', () => {
  it('marks the request FAILED under the tenant with an explicit tenant predicate', async () => {
    setTenantQueryMock.mockResolvedValueOnce([]);

    const marked = await abdmService._markDataRequestFailed('txn-1', TENANT);

    expect(marked).toBe(true);
    expect(setTenantMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const [sql, transactionId, tenantId] = setTenantQueryMock.mock.calls[0];
    expect(sql).toContain("SET status = 'FAILED'");
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(sql).toContain("status = 'PROCESSING'");
    expect(transactionId).toBe('txn-1');
    expect(tenantId).toBe(TENANT);
  });

  it('retries the marker write and succeeds on a later attempt', async () => {
    setTenantQueryMock
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([]);

    const marked = await abdmService._markDataRequestFailed('txn-2', TENANT, { backoffMs: 1 });

    expect(marked).toBe(true);
    expect(setTenantQueryMock).toHaveBeenCalledTimes(3);
    expect(loggerError).toHaveBeenCalledWith(
      'ABDM data request FAILED-marker write failed',
      expect.objectContaining({ transactionId: 'txn-2', attempt: 1 }),
    );
  });

  it('logs loudly and returns false (never throws) when every attempt fails', async () => {
    setTenantQueryMock.mockRejectedValue(new Error('db down'));

    const marked = await abdmService._markDataRequestFailed('txn-3', TENANT, { backoffMs: 1 });

    expect(marked).toBe(false);
    expect(setTenantQueryMock).toHaveBeenCalledTimes(3);
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('stuck in PROCESSING'),
      expect.objectContaining({ transactionId: 'txn-3', tenantId: TENANT }),
    );
  });
});

describe('abdmService.sweepStuckDataRequests (BE-M7 backstop)', () => {
  it('returns zero counters without logging when nothing is stuck', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const result = await abdmService.sweepStuckDataRequests();

    expect(result).toEqual({ scanned: 0, swept: 0, failed: 0 });
    expect(setTenantMock).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('marks stale PROCESSING rows FAILED per tenant and reports counts', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { transaction_id: 'txn-a', tenant_id: TENANT },
      { transaction_id: 'txn-b', tenant_id: '00000000-0000-4000-8000-000000000002' },
    ]);
    setTenantQueryMock
      .mockResolvedValueOnce([]) // txn-a marker lands
      .mockRejectedValueOnce(new Error('db down')); // txn-b marker fails

    const result = await abdmService.sweepStuckDataRequests({ olderThanMinutes: 60 });

    expect(result).toEqual({ scanned: 2, swept: 1, failed: 1 });

    // Discovery query excludes I16 recovery-claimed rows and is bounded.
    const [selectSql, olderThan, limit] = queryRawUnsafeMock.mock.calls[0];
    expect(selectSql).toContain("status = 'PROCESSING'");
    expect(selectSql).toContain('recovery_inbox_id IS NULL');
    expect(olderThan).toBe(60);
    expect(limit).toBe(100);

    // Each marker ran under its own tenant.
    expect(setTenantMock).toHaveBeenNthCalledWith(1, TENANT, expect.any(Function));
    expect(setTenantMock).toHaveBeenNthCalledWith(
      2, '00000000-0000-4000-8000-000000000002', expect.any(Function),
    );

    // The stuck finding itself is loud.
    expect(loggerError).toHaveBeenCalledWith(
      'ABDM stuck data requests found in PROCESSING past the deadline',
      expect.objectContaining({ count: 2, transaction_ids: ['txn-a', 'txn-b'] }),
    );
  });
});
