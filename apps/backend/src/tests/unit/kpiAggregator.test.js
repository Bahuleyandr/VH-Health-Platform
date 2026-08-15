import { jest } from '@jest/globals';

// Regression pin for the cross-tenant admin:kpi leak: the aggregator used to
// run ONE fleet-wide beds/appointments count under runWithSuperAdmin and emit
// it tenant-null, which the wsServer per-broadcast tenant filter delivers to
// EVERY tenant's admin sockets. It must fan out per active tenant (like
// dailyOpsBroadcaster), carry an explicit tenant predicate on every tile
// query, and stamp every emit with that tenant's id.

const runForEachTenant = jest.fn(async (_label, fn) => {
  const failures = [];
  for (const tenantId of ['t-1', 't-2']) {
    try { await fn(tenantId); } catch (err) { failures.push(err); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'tenant fan-out failed');
});
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({ runForEachTenant }));

const queryRawUnsafeMock = jest.fn(async (sql) => {
  if (sql.includes('FROM beds')) {
    return [{ total: 10, occupied: 5, available: 4, other: 1 }];
  }
  return [{ waiting: 3, in_progress: 2, active_doctors: 2 }];
});
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

const emitAdminKpiMock = jest.fn();
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAdminKpi: emitAdminKpiMock,
}));

const loggerWarn = jest.fn();
const loggerInfo = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: jest.fn() },
}));

const { tickAdminKpi } = await import('../../utils/kpiAggregator.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('FROM beds')) {
      return [{ total: 10, occupied: 5, available: 4, other: 1 }];
    }
    return [{ waiting: 3, in_progress: 2, active_doctors: 2 }];
  });
});

describe('tickAdminKpi', () => {
  test('fans out per tenant under the admin-kpi-tick fan-out label', async () => {
    await tickAdminKpi();
    expect(runForEachTenant).toHaveBeenCalledTimes(1);
    expect(runForEachTenant.mock.calls[0][0]).toBe('admin-kpi-tick');
  });

  test('every tile query carries an explicit tenant predicate bound to that tenant', async () => {
    await tickAdminKpi();
    // 2 tiles × 2 tenants
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(4);
    for (const call of queryRawUnsafeMock.mock.calls) {
      expect(call[0]).toMatch(/WHERE tenant_id = \$1::uuid/);
      expect(['t-1', 't-2']).toContain(call[1]);
    }
    const tenantsQueried = (fragment) => queryRawUnsafeMock.mock.calls
      .filter((call) => call[0].includes(fragment))
      .map((call) => call[1])
      .sort();
    expect(tenantsQueried('FROM beds')).toEqual(['t-1', 't-2']);
    expect(tenantsQueried('FROM appointments')).toEqual(['t-1', 't-2']);
  });

  test('emits each tile stamped with its tenant id and the unchanged payload shape', async () => {
    await tickAdminKpi();
    expect(emitAdminKpiMock).toHaveBeenCalledTimes(4);
    for (const tenantId of ['t-1', 't-2']) {
      expect(emitAdminKpiMock).toHaveBeenCalledWith('bed-occupancy', {
        total: 10,
        occupied: 5,
        available: 4,
        other: 1,
        occupancyPct: 50,
      }, { tenantId });
      expect(emitAdminKpiMock).toHaveBeenCalledWith('waiting-queue', {
        waiting: 3,
        inProgress: 2,
        activeDoctors: 2,
      }, { tenantId });
    }
    // No emit may leave without a tenant stamp — tenant-null admin:kpi
    // broadcasts match every connected socket.
    for (const call of emitAdminKpiMock.mock.calls) {
      expect(call[2]).toEqual({ tenantId: expect.stringMatching(/^t-/) });
    }
  });

  test('a single tile failure is logged and skipped without blocking the tenant tick', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM beds')) throw new Error('beds query failed');
      return [{ waiting: 3, in_progress: 2, active_doctors: 2 }];
    });
    await expect(tickAdminKpi()).resolves.toBeUndefined();
    // The waiting-queue tile still emitted for both tenants.
    expect(emitAdminKpiMock).toHaveBeenCalledTimes(2);
    for (const call of emitAdminKpiMock.mock.calls) {
      expect(call[0]).toBe('waiting-queue');
    }
    expect(loggerWarn).toHaveBeenCalledTimes(2);
  });
});
