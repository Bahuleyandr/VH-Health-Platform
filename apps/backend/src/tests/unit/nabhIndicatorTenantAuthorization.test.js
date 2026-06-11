import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  computeIndicators,
  snapshotIndicators,
  listSnapshots,
} = await import('../../services/quality/nabhIndicatorService.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
});

describe('NABH indicator tenant authorization', () => {
  it('requires tenant context for compute, snapshot, and list operations', async () => {
    await expect(computeIndicators({ from: '2026-06-01', to: '2026-06-30' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
    await expect(snapshotIndicators({ from: '2026-06-01', to: '2026-06-30' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
    await expect(listSnapshots()).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
  });

  it('binds tenant_id into every source query while computing indicators', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    const pack = await computeIndicators({
      from: '2026-06-01',
      to: '2026-06-30',
      tenantId: TENANT,
    });

    expect(pack.indicators).toHaveLength(7);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(9);
    for (const call of queryRawUnsafeMock.mock.calls) {
      expect(call[0]).toContain('tenant_id = $1::uuid');
      expect(call[1]).toBe(TENANT);
    }

    const incidentSql = queryRawUnsafeMock.mock.calls.at(-1)[0];
    expect(incidentSql).toContain('TRIM(incident_type)');
    expect(incidentSql).not.toContain('TRIM(category)');
  });

  it('writes and lists snapshots under the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ ama: 0, total: 0 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ patient_days: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 1 }]);

    const snapshot = await snapshotIndicators(
      { from: '2026-06-01', to: '2026-06-30' },
      { tenantId: TENANT, actorUid: ACTOR },
    );

    expect(snapshot.snapshot_saved).toBe(7);
    const insertCalls = queryRawUnsafeMock.mock.calls.slice(9);
    for (const call of insertCalls) {
      expect(call[0]).toContain('INSERT INTO nabh_indicator_snapshots');
      expect(call[0]).toContain('(tenant_id, period_start');
      expect(call[1]).toBe(TENANT);
    }

    queryRawUnsafeMock.mockClear();
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listSnapshots({ tenantId: TENANT, from: '2026-06-01', to: '2026-06-30' });

    const [listSql, ...listParams] = queryRawUnsafeMock.mock.calls[0];
    expect(listSql).toContain('FROM nabh_indicator_snapshots WHERE tenant_id = $1::uuid');
    expect(listParams).toEqual([TENANT, '2026-06-01', '2026-06-30']);
  });
});
