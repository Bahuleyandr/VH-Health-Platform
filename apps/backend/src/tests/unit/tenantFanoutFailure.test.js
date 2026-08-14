import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const logger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    $transaction: async fn => fn({ $queryRawUnsafe: queryRawUnsafe }),
  },
  setTenant: jest.fn(),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runInTenantContext: async (_tenantId, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));

const { runForEachTenant } = await import('../../utils/tenantFanout.js');

beforeEach(() => {
  queryRawUnsafe.mockReset();
  logger.error.mockReset();
});

describe('tenant fan-out discovery failure', () => {
  it('records reconciliation_failed without claiming tenant discovery ran', async () => {
    const reconciliationError = new Error('stale ledger unavailable');
    reconciliationError.code = 'STALE_LEDGER_DOWN';
    queryRawUnsafe
      .mockResolvedValueOnce([{ id: 90n }])
      .mockRejectedValueOnce(reconciliationError)
      .mockResolvedValueOnce([{ id: 90n }]);
    const perTenant = jest.fn();

    await expect(runForEachTenant('reconciliation-failure-test', perTenant))
      .rejects.toMatchObject({
        name: 'TenantFanoutAggregateError',
        message: 'reconciliation-failure-test: stale-run reconciliation failed',
        result: { runId: '90', tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
      });

    expect(perTenant).not.toHaveBeenCalled();
    expect(queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(String(queryRawUnsafe.mock.calls[2][0])).toContain(
      "aggregate_status = 'reconciliation_failed'",
    );
    expect(queryRawUnsafe.mock.calls[2].slice(1)).toEqual([90n, 'STALE_LEDGER_DOWN']);
  });

  it('records discovery_failed and never executes a default-tenant fallback', async () => {
    const discoveryError = new Error('tenant catalog unavailable');
    discoveryError.code = 'TENANT_CATALOG_DOWN';
    queryRawUnsafe
      .mockResolvedValueOnce([{ id: 91n }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(discoveryError)
      .mockResolvedValueOnce([{ id: 91n }]);
    const perTenant = jest.fn();

    let aggregate;
    try {
      await runForEachTenant('discovery-failure-test', perTenant);
    } catch (err) {
      aggregate = err;
    }

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.name).toBe('TenantFanoutAggregateError');
    expect(aggregate.message).toBe('discovery-failure-test: tenant discovery failed');
    expect(aggregate.result).toEqual({
      runId: '91', tenantsDiscovered: 0, tenantsRun: 0, errors: 1,
    });
    expect(perTenant).not.toHaveBeenCalled();
    expect(queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(String(queryRawUnsafe.mock.calls[3][0])).toContain("aggregate_status = 'discovery_failed'");
    expect(queryRawUnsafe.mock.calls[3].slice(1)).toEqual([91n, 'TENANT_CATALOG_DOWN']);
  });

  it('treats an empty active-tenant result as a discovery failure', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ id: 92n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 92n }]);

    await expect(runForEachTenant('empty-discovery-test', jest.fn()))
      .rejects.toMatchObject({
        name: 'TenantFanoutAggregateError',
        result: { tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
      });
    expect(queryRawUnsafe.mock.calls[3].slice(1)).toEqual([92n, 'TENANT_DISCOVERY_EMPTY']);
  });
});
