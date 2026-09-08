import fs from 'node:fs';
import { jest } from '@jest/globals';

const tenantIds = [
  'dd100000-0000-4000-8000-000000000001', 'dd100000-0000-4000-8000-000000000002',
];
const query = jest.fn();
const visited = [];
const tenantTx = async (tenantId, callback) => callback({
  $queryRawUnsafe: (sql, ...values) => query(sql, ...values),
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {}, setTenant: tenantTx, setTenantTx: tenantTx,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({ requireTenantId: value => value }));
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({
  runForEachTenant: async (label, callback) => {
    let errors = 0;
    for (const tenantId of tenantIds) {
      visited.push(tenantId);
      try { await callback(tenantId); } catch { errors += 1; }
    }
    const result = { runId: '123', tenantsDiscovered: tenantIds.length, tenantsRun: tenantIds.length, errors };
    if (errors) { const error = new Error('Fleet delivery failed'); error.result = result; throw error; }
    return result;
  },
}));

const { drainExposureOutboxForAllTenants } = await import('../../services/clinical/bloodborneExposureOutboxService.js');
const { registerExposureHandler, __clearExposureHandlersForTests } = await import('../../services/clinical/bloodborneMarkerRules.js');

describe('bloodborne exposure reconciliation population', () => {
  beforeEach(() => {
    query.mockReset();
    visited.length = 0;
    __clearExposureHandlersForTests();
    const handlers = ['cath-device-reuse.v1', 'platform-reprocessable-devices.v1'];
    expect(handlers).toHaveLength(2);
    for (const id of handlers) registerExposureHandler({ id, apply: async () => ({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
    }) });
  });

  test('dry run counts every discovered tenant and never claims work', async () => {
    expect(tenantIds).toHaveLength(2);
    query.mockResolvedValue([{ population: 3, pending: 1, failed: 1, drained: 1 }]);
    const result = await drainExposureOutboxForAllTenants({ dryRun: true });
    expect(visited).toHaveLength(2);
    expect(visited).toEqual(tenantIds);
    expect(result).toEqual({ population: 6, pending: 2, failed: 2, drained: 2, claimed: 0,
      tenants_discovered: 2, tenants_completed: 2, run_id: '123' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sql.includes('SELECT count(*)'))).toEqual([true, true]);
  });

  test('failed backoff work fails the sweep while preserving tenant and event populations', async () => {
    expect(tenantIds).toHaveLength(2);
    query.mockImplementation(async (sql, tenantId) => {
      if (!sql.includes('SELECT count(*)')) return [];
      return [{ population: 1, pending: 0, failed: tenantId === tenantIds[0] ? 1 : 0,
        drained: tenantId === tenantIds[0] ? 0 : 1 }];
    });
    await expect(drainExposureOutboxForAllTenants()).rejects.toMatchObject({
      result: { population: 2, failed: 1, drained: 1, tenantsDiscovered: 2, tenantsRun: 2, errors: 1 },
    });
    expect(visited).toHaveLength(2);
    expect(visited).toEqual(tenantIds);
  });

  test('scheduler and operator sweep invoke the durable drain before marker repair', () => {
    const scheduler = fs.readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');
    const script = fs.readFileSync(new URL('../../../scripts/reconcile-bloodborne-markers.mjs', import.meta.url), 'utf8');
    const entryPoints = [
      scheduler.includes("withJobLock('bloodborne-exposure-outbox-drain'"),
      scheduler.includes('await drainExposureOutboxForAllTenants()'),
      script.includes("const exposure = await drainExposureOutboxForAllTenants({ dryRun: true })"),
    ];
    expect(entryPoints).toHaveLength(3);
    expect(entryPoints).toEqual([true, true, true]);
    expect(script.indexOf('if (!dryRun) await drainExposureOutboxForAllTenants()'))
      .toBeLessThan(script.indexOf('return reconcileAllTenants('));
    expect(script).toContain('exposure_outbox:');
  });
});
