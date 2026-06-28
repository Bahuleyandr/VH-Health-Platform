import { jest } from '@jest/globals';

const runForEachTenant = jest.fn(async (_label, fn) => { await fn('t-1'); await fn('t-2'); });
const getDailyOpsSnapshot = jest.fn(async ({ tenantId }) => ({ d: '2026-06-28', tenantId, opd_today: 1 }));
const emitDailyOpsMock = jest.fn();
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));
jest.unstable_mockModule('../../services/dashboards/snapshotService.js', () => ({ getDailyOpsSnapshot }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({ emitDailyOps: emitDailyOpsMock }));

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
    expect(emitDailyOpsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1' }), { tenantId: 't-1' });
    expect(emitDailyOpsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-2' }), { tenantId: 't-2' });
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(2);
  });

  test('skips emit when a tenant snapshot is null', async () => {
    getDailyOpsSnapshot.mockResolvedValueOnce(null); // t-1 → null
    await tickDailyOps();
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(1); // only t-2
  });

  test('isolates a per-tenant failure so other tenants still emit', async () => {
    getDailyOpsSnapshot.mockRejectedValueOnce(new Error('boom')); // t-1 throws
    await expect(tickDailyOps()).resolves.not.toThrow();
    expect(emitDailyOpsMock).toHaveBeenCalledTimes(1); // t-2 still emits
  });
});
