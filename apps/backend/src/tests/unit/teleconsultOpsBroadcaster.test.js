import { jest } from '@jest/globals';

const runForEachTenant = jest.fn(async (_label, fn) => { await fn('t-1'); await fn('t-2'); });
const getTeleconsultOpsSnapshot = jest.fn(async ({ tenantId }) => ({ tenantId, active_count: 1, waiting_count: 2 }));
const emitTeleconsultOpsMock = jest.fn();
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));
jest.unstable_mockModule('../../services/dashboards/teleconsultOpsService.js', () => ({ getTeleconsultOpsSnapshot }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({ emitTeleconsultOps: emitTeleconsultOpsMock }));

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
    expect(emitTeleconsultOpsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1' }), { tenantId: 't-1' });
    expect(emitTeleconsultOpsMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-2' }), { tenantId: 't-2' });
    expect(emitTeleconsultOpsMock).toHaveBeenCalledTimes(2);
  });

  test('skips emit when a tenant snapshot is null', async () => {
    getTeleconsultOpsSnapshot.mockResolvedValueOnce(null);
    await tickTeleconsultOps();
    expect(emitTeleconsultOpsMock).toHaveBeenCalledTimes(1);
  });

  test('isolates a per-tenant failure so other tenants still emit', async () => {
    getTeleconsultOpsSnapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(tickTeleconsultOps()).resolves.not.toThrow();
    expect(emitTeleconsultOpsMock).toHaveBeenCalledTimes(1);
  });
});
