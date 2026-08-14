import fs from 'node:fs';
import path from 'node:path';
import { jest } from '@jest/globals';

// The fan-out helper reaches for four things on the prisma module: the default
// client (`$queryRawUnsafe` for fleet receipts, `$transaction` for stale-run
// reconciliation), the named `setTenant` export for per-tenant receipts, and
// `runInTenantContext` for the RLS context around each tenant body. Mocking
// only `default.$queryRawUnsafe` makes the suite fail at module load with
// "does not provide an export named 'setTenant'".
const queryRawUnsafe = jest.fn();
const tenantQuery = jest.fn();
const logger = {
  debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    $transaction: async fn => fn({ $queryRawUnsafe: queryRawUnsafe }),
  },
  setTenant: async (tenantId, fn) => fn({
    $queryRawUnsafe: (...args) => tenantQuery(tenantId, ...args),
  }),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runInTenantContext: async (_tenantId, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));

const { runForEachTenant } = await import('../../utils/tenantFanout.js');

const scheduler = fs.readFileSync(
  path.resolve(process.cwd(), 'src/utils/scheduler.js'),
  'utf8',
);

describe('interface-engine scheduler wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRawUnsafe.mockReset();
    tenantQuery.mockReset();
  });

  test('runs a locked tenant fanout with bounded dispatch inputs', () => {
    expect(scheduler).toContain(
      "registerCron('* * * * *', withJobLock('interface-engine-outbound-dispatch'",
    );
    expect(scheduler).toContain(
      "runForEachTenant('interface-engine-outbound-dispatch', tenantId => (",
    );
    expect(scheduler).toContain(
      'dispatchOutboundMessages({ tenantId, batchSize: 25, maxInFlight: 100 })',
    );
    // The call closes right after the callback — no options bag. `runForEachTenant`
    // destructures only `lockKey` and is fail-closed for every caller, so a
    // `{ strict: true }` here would be silently swallowed decoration.
    expect(scheduler).toMatch(
      /dispatchOutboundMessages\(\{ tenantId, batchSize: 25, maxInFlight: 100 \}\)\s*\)\);/,
    );
  });

  test('fanout rejects discovery fallback instead of reporting default-only success', async () => {
    const discoveryFailureReceipts = [];
    queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_runs')) return [{ id: 41n }];
      if (text.includes('started_at < NOW()')) return [];
      if (text.includes('FROM tenants') && text.includes("status = 'active'")) {
        throw new Error('tenant discovery unavailable');
      }
      if (text.includes("aggregate_status = 'discovery_failed'")) {
        discoveryFailureReceipts.push(params);
        return [{ id: 41n }];
      }
      throw new Error(`Unexpected fleet receipt query: ${text}`);
    });
    const dispatch = jest.fn();

    let aggregate;
    try {
      await runForEachTenant('interface-engine-outbound-dispatch', dispatch);
    } catch (err) {
      aggregate = err;
    }

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.name).toBe('TenantFanoutAggregateError');
    expect(aggregate.message).toBe(
      'interface-engine-outbound-dispatch: tenant discovery failed',
    );
    // The underlying discovery error is carried, never swallowed into a
    // default-tenant "success".
    expect(aggregate.errors.map(err => err.message))
      .toContain('tenant discovery unavailable');
    expect(aggregate.result).toEqual({
      runId: '41', tenantsDiscovered: 0, tenantsRun: 0, errors: 1,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(tenantQuery).not.toHaveBeenCalled();
    // The durable receipt records the failure rather than a clean tick.
    expect(discoveryFailureReceipts).toEqual([[41n, 'TENANT_DISCOVERY_FAILED']]);
  });

  test('fanout visits healthy tenants but rejects the aggregate on a tenant failure', async () => {
    const aggregateReceipts = [];
    queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_runs')) return [{ id: 42n }];
      if (text.includes('started_at < NOW()')) return [];
      if (text.includes('FROM tenants') && text.includes("status = 'active'")) {
        return [{ id: 'tenant-a' }, { id: 'tenant-b' }];
      }
      if (text.includes("SET discovery_status = 'succeeded'")) return [{ id: 42n }];
      if (text.includes('SET aggregate_status = $2::text')) {
        aggregateReceipts.push(params);
        return [{ id: 42n }];
      }
      throw new Error(`Unexpected fleet receipt query: ${text}`);
    });
    tenantQuery.mockImplementation(async (_tenantId, sql) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_tenant_runs') && !text.includes('ON CONFLICT')) {
        return [{ run_id: 42n }];
      }
      if (text.includes('UPDATE scheduled_job_tenant_runs')) return [{ run_id: 42n }];
      throw new Error(`Unexpected tenant receipt query: ${text}`);
    });
    const dispatch = jest.fn(async (tenantId) => {
      if (tenantId === 'tenant-a') throw new Error('dispatch failed');
    });

    await expect(runForEachTenant(
      'interface-engine-outbound-dispatch',
      dispatch,
    )).rejects.toThrow('1 tenant run(s) failed');
    expect(dispatch).toHaveBeenCalledWith('tenant-b');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('interface-engine-outbound-dispatch: failed for tenant tenant-a'),
      expect.any(Error),
    );
    // One healthy tenant, one failed tenant, nothing unresolved.
    expect(aggregateReceipts).toEqual([[42n, 'partial_failure', 1, 1, 0, 'TENANT_RUN_FAILURE']]);
  });
});
