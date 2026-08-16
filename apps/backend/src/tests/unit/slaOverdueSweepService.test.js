import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(prismaMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { runWorkflowSlaOverdueSweep } = await import(
  '../../services/workflow/slaOverdueSweepService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-16T10:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runWorkflowSlaOverdueSweep', () => {
  it('flips only active past-due rows via a single SKIP LOCKED claim and stamps breached_at = due_at', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { id: 'a', rule_code: 'bed_cleaning_turnaround', source_table: 'beds', source_id: '1', priority: 'high' },
      { id: 'b', rule_code: 'bed_cleaning_turnaround', source_table: 'housekeeping_requests', source_id: '2', priority: 'high' },
      { id: 'c', rule_code: 'stroke_door_to_needle', source_table: 'stroke_activations', source_id: '3', priority: 'critical' },
    ]);

    const result = await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW });

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(TENANT);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);

    const [sql, ...params] = prismaMock.$queryRawUnsafe.mock.calls[0];
    // Candidate filter: only active, incomplete, dated, past-due clocks.
    expect(sql).toContain(`status = 'active'`);
    expect(sql).toContain('completed_at IS NULL');
    expect(sql).toContain('due_at IS NOT NULL');
    expect(sql).toContain('due_at < $2::timestamptz');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT $3::int');
    // Breach stamping: the breach moment is due_at, not detection time, and
    // an existing breached_at (porter sweep overlap) is preserved.
    expect(sql).toContain(`SET status = 'breached'`);
    expect(sql).toContain('breached_at = COALESCE(i.breached_at, i.due_at)');
    expect(sql).toContain(`'breached_by', 'workflow-sla-overdue-sweep'`);
    expect(sql).toContain(`'breach_detected_at', $2::timestamptz`);
    // Never escalates and never touches terminal rows: the only status the
    // statement filters on is 'active', and the only status it writes is
    // 'breached'.
    expect(sql).not.toContain(`'escalated'`);
    expect(sql).not.toContain(`'completed'`);
    expect(sql).not.toContain(`'cancelled'`);
    expect(params).toEqual([TENANT, NOW.toISOString(), 200]);

    expect(result).toEqual({
      breached: 3,
      byRule: {
        bed_cleaning_turnaround: 2,
        stroke_door_to_needle: 1,
      },
    });
  });

  it('passes the per-tenant limit through and clamps nonsense values to the default', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);

    await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW, limit: 50 });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][3]).toBe(50);

    await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW, limit: -5 });
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][3]).toBe(200);

    await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW, limit: 999999 });
    expect(prismaMock.$queryRawUnsafe.mock.calls[2][3]).toBe(1000);
  });

  it('uses a caller-provided transaction client instead of opening its own', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };

    const result = await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW, db: tx });

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({ breached: 0, byRule: {} });
  });

  it('requires a tenant id', async () => {
    const prior = process.env.ALLOW_DEFAULT_TENANT;
    process.env.ALLOW_DEFAULT_TENANT = 'false';
    try {
      await expect(runWorkflowSlaOverdueSweep({})).rejects.toMatchObject({
        code: 'TENANT_CONTEXT_REQUIRED',
      });
    } finally {
      if (prior === undefined) delete process.env.ALLOW_DEFAULT_TENANT;
      else process.env.ALLOW_DEFAULT_TENANT = prior;
    }
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('never throws out of a failed sweep tick (cron safety) and reports zero', async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('connection reset'));

    const result = await runWorkflowSlaOverdueSweep({ tenantId: TENANT, now: NOW });

    expect(result).toEqual({ breached: 0, byRule: {} });
  });
});

describe('scheduler wiring (mirrors the drug-chart-missing-sla pattern)', () => {
  const scheduler = readFileSync(
    new URL('../../utils/scheduler.js', import.meta.url),
    'utf8',
  );

  it('registers the five-minute sweep under the advisory job lock with per-tenant fan-out', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('workflow-sla-overdue-sweep'",
    );
    expect(scheduler).toContain("runForEachTenant('workflow-sla-overdue-sweep'");
    // Lazy import only — the sweep must not pull prisma into the scheduler's
    // own static import graph (same shape as the SOS sweep).
    expect(scheduler).not.toMatch(/^import .*slaOverdueSweepService\.js/m);
    expect(scheduler).toContain(
      "await import('../services/workflow/slaOverdueSweepService.js')",
    );
  });

  it('exposes a matching manual/boot task', () => {
    expect(scheduler).toContain("runManualTask('workflow-sla-overdue-sweep'");
    expect(scheduler).toContain("withDbAdvisoryLock('workflow-sla-overdue-sweep'");
  });
});
