import { jest } from '@jest/globals';

const TENANT_A = 'a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a801';
const TENANT_B = 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b802';
const queryRawUnsafe = jest.fn();
const tenantQuery = jest.fn();

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
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const { runForEachTenant } = await import('../../utils/tenantFanout.js');

describe('tenant fan-out receipt failure accounting', () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
    tenantQuery.mockReset();
  });

  it('continues healthy tenants and finalizes evidence_failure when one outcome is unresolved', async () => {
    queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_runs')) return [{ id: 101n }];
      if (text.includes('started_at < NOW()')) return [];
      if (text.includes('FROM tenants') && text.includes("status = 'active'")) {
        return [{ id: TENANT_A }, { id: TENANT_B }];
      }
      if (text.includes("SET discovery_status = 'succeeded'")) return [{ id: 101n }];
      if (text.includes('SET aggregate_status = $2::text')) {
        expect(params).toEqual([101n, 'evidence_failure', 1, 0, 1, 'TENANT_OUTCOME_UNRESOLVED']);
        return [{ id: 101n }];
      }
      throw new Error(`Unexpected global receipt query: ${text}`);
    });
    tenantQuery.mockImplementation(async (tenantId, sql) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_tenant_runs') && !text.includes('ON CONFLICT')) {
        return [{ run_id: 101n }];
      }
      if (tenantId === TENANT_A && (
        text.includes('UPDATE scheduled_job_tenant_runs')
        || text.includes('ON CONFLICT (run_id, tenant_id)')
      )) {
        throw new Error('receipt store unavailable');
      }
      if (tenantId === TENANT_B && text.includes('UPDATE scheduled_job_tenant_runs')) {
        return [{ run_id: 101n }];
      }
      throw new Error(`Unexpected tenant receipt query: ${text}`);
    });
    const seen = [];

    await expect(runForEachTenant('receipt-failure-test', async tenantId => seen.push(tenantId)))
      .rejects.toMatchObject({
        name: 'TenantFanoutAggregateError',
        result: { tenantsDiscovered: 2, tenantsRun: 1, errors: 1 },
      });
    expect(seen).toEqual([TENANT_A, TENANT_B]);
  });
});
