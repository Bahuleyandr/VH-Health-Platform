import fs from 'node:fs';
import path from 'node:path';
import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const logger = {
  debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
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

const { runFleetJob } = await import('../../utils/tenantFanout.js');

const scheduler = fs.readFileSync(
  path.resolve(process.cwd(), 'src/utils/scheduler.js'),
  'utf8',
);

function receiptRouter({ onCreate, onFinish, finishResult = [{ id: 77n }] } = {}) {
  return async (sql, ...params) => {
    const text = String(sql);
    if (text.includes('INSERT INTO scheduled_job_runs')) {
      onCreate?.(params);
      return [{ id: 77n }];
    }
    if (text.includes('started_at < NOW()')) return [];
    if (text.includes("scope = 'fleet'")) {
      onFinish?.(params);
      return finishResult;
    }
    throw new Error(`Unexpected fleet receipt query: ${text}`);
  };
}

describe('fleet scheduled-job wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRawUnsafe.mockReset();
  });

  test('the two direct critical crons run behind the fleet receipt', () => {
    expect(scheduler).toContain(
      "runFleetJob('audit-chain-verify', () => runAuditChainVerification())",
    );
    expect(scheduler).toContain(
      "runFleetJob('results-inbox-escalation', () => runEscalationSweep({}))",
    );
    // Neither may keep a bare unreceipted call site.
    expect(scheduler).not.toMatch(/await runAuditChainVerification\(\);/);
    expect(scheduler).not.toMatch(/await runEscalationSweep\(\{\}\);/);
  });

  test('opens the run as fleet scope and closes it as succeeded', async () => {
    const created = [];
    const finished = [];
    queryRawUnsafe.mockImplementation(receiptRouter({
      onCreate: params => created.push(params),
      onFinish: params => finished.push(params),
    }));

    const outcome = await runFleetJob('audit-chain-verify', async () => ({ tenantsChecked: 2 }));

    expect(outcome).toEqual({ runId: '77', result: { tenantsChecked: 2 } });
    expect(created).toEqual([['audit-chain-verify', 'audit-chain-verify', 'fleet']]);
    expect(finished).toEqual([[77n, 'succeeded', null]]);
  });

  test('records job_failed with the body failure code and rejects', async () => {
    const finished = [];
    queryRawUnsafe.mockImplementation(receiptRouter({
      onFinish: params => finished.push(params),
    }));
    const bodyError = new Error('escalation sweep exploded');
    bodyError.code = 'ESCALATION_SWEEP_FAILED';

    await expect(runFleetJob('results-inbox-escalation', async () => { throw bodyError; }))
      .rejects.toMatchObject({
        name: 'TenantFanoutAggregateError',
        message: 'results-inbox-escalation: fleet job failed',
        result: { runId: '77', scope: 'fleet' },
      });
    expect(finished).toEqual([[77n, 'job_failed', 'ESCALATION_SWEEP_FAILED']]);
  });

  test('refuses to report success when the outcome receipt does not persist', async () => {
    queryRawUnsafe.mockImplementation(receiptRouter({ finishResult: [] }));

    await expect(runFleetJob('audit-chain-verify', async () => 'swept'))
      .rejects.toMatchObject({
        name: 'TenantFanoutAggregateError',
        message: 'audit-chain-verify: fleet job completed but its outcome receipt failed',
      });
  });

  test('records reconciliation_failed when stale-run reaping fails', async () => {
    const finished = [];
    const reconciliationError = new Error('stale ledger unavailable');
    reconciliationError.code = 'STALE_LEDGER_DOWN';
    queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO scheduled_job_runs')) return [{ id: 77n }];
      if (text.includes('started_at < NOW()')) throw reconciliationError;
      if (text.includes("scope = 'fleet'")) {
        finished.push(params);
        return [{ id: 77n }];
      }
      throw new Error(`Unexpected fleet receipt query: ${text}`);
    });
    const body = jest.fn();

    await expect(runFleetJob('audit-chain-verify', body)).rejects.toMatchObject({
      message: 'audit-chain-verify: stale-run reconciliation failed',
    });
    expect(body).not.toHaveBeenCalled();
    expect(finished).toEqual([[77n, 'reconciliation_failed', 'STALE_LEDGER_DOWN']]);
  });
});
