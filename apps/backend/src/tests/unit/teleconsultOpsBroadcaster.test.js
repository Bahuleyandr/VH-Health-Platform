import { jest } from '@jest/globals';

const runForEachTenant = jest.fn(async (_label, fn) => {
  const failures = [];
  for (const tenantId of ['t-1', 't-2']) {
    try { await fn(tenantId); } catch (err) { failures.push(err); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'tenant fan-out failed');
});
const getTeleconsultOpsSnapshot = jest.fn(async ({ tenantId }) => ({ tenantId, active_count: 1, waiting_count: 2 }));
const emitTeleconsultOpsConfirmedMock = jest.fn(async () => ({ scope: 'fleet' }));
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));
jest.unstable_mockModule('../../services/dashboards/teleconsultOpsService.js', () => ({ getTeleconsultOpsSnapshot }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitTeleconsultOpsConfirmed: emitTeleconsultOpsConfirmedMock,
}));

const { tickTeleconsultOps } = await import('../../utils/teleconsultOpsBroadcaster.js');

describe('tickTeleconsultOps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTeleconsultOpsSnapshot.mockImplementation(async ({ tenantId }) => ({ tenantId, active_count: 1, waiting_count: 2 }));
  });

  test('computes and emits a snapshot per tenant', async () => {
    await tickTeleconsultOps();
    expect(getTeleconsultOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-1' });
    expect(getTeleconsultOpsSnapshot).toHaveBeenCalledWith({ tenantId: 't-2' });
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1' }), { tenantId: 't-1' });
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-2' }), { tenantId: 't-2' });
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledTimes(2);
  });

  test('skips emit when a tenant snapshot is null', async () => {
    getTeleconsultOpsSnapshot.mockResolvedValueOnce(null);
    await tickTeleconsultOps();
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledTimes(1);
  });

  test('continues other tenants but rejects the aggregate after a per-tenant failure', async () => {
    getTeleconsultOpsSnapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(tickTeleconsultOps()).rejects.toBeInstanceOf(AggregateError);
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledTimes(1);
  });

  test('continues other tenants but rejects when fleet publication fails', async () => {
    emitTeleconsultOpsConfirmedMock.mockRejectedValueOnce(new Error('redis publish failed'));
    await expect(tickTeleconsultOps()).rejects.toBeInstanceOf(AggregateError);
    expect(emitTeleconsultOpsConfirmedMock).toHaveBeenCalledTimes(2);
  });
});
