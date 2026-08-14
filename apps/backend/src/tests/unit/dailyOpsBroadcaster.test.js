import { jest } from '@jest/globals';

const runForEachTenant = jest.fn(async (_label, fn) => {
  const failures = [];
  for (const tenantId of ['t-1', 't-2']) {
    try { await fn(tenantId); } catch (err) { failures.push(err); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'tenant fan-out failed');
});
const getDailyOpsSnapshot = jest.fn(async ({ tenantId }) => ({ d: '2026-06-28', tenantId, opd_today: 1 }));
const emitDailyOpsConfirmedMock = jest.fn(async () => ({ scope: 'fleet' }));
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));
jest.unstable_mockModule('../../services/dashboards/snapshotService.js', () => ({ getDailyOpsSnapshot }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitDailyOpsConfirmed: emitDailyOpsConfirmedMock,
}));

const { tickDailyOps } = await import('../../utils/dailyOpsBroadcaster.js');

describe('tickDailyOps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDailyOpsSnapshot.mockImplementation(async ({ tenantId }) => ({ d: '2026-06-28', tenantId, opd_today: 1 }));
  });

  test('computes and emits a snapshot per tenant', async () => {
    await tickDailyOps();
    expect(getDailyOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-1' });
    expect(getDailyOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-2' });
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1' }), { tenantId: 't-1' });
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-2' }), { tenantId: 't-2' });
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledTimes(2);
  });

  test('skips emit when a tenant snapshot is null', async () => {
    getDailyOpsSnapshot.mockResolvedValueOnce(null); // t-1 → null
    await tickDailyOps();
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledTimes(1); // only t-2
  });

  test('continues other tenants but rejects the aggregate after a per-tenant failure', async () => {
    getDailyOpsSnapshot.mockRejectedValueOnce(new Error('boom')); // t-1 throws
    await expect(tickDailyOps()).rejects.toBeInstanceOf(AggregateError);
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledTimes(1); // t-2 still emits
  });

  test('continues other tenants but rejects when fleet publication fails', async () => {
    emitDailyOpsConfirmedMock.mockRejectedValueOnce(new Error('redis publish failed'));
    await expect(tickDailyOps()).rejects.toBeInstanceOf(AggregateError);
    expect(emitDailyOpsConfirmedMock).toHaveBeenCalledTimes(2);
  });
});
