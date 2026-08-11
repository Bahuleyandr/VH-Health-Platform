import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const setTenantMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenant: setTenantMock,
  setTenantTx: async (_tenantId, callback) => callback({ $queryRawUnsafe: queryRawUnsafeMock }),
  isTenantTransactionClient: () => true,
  circuitBreakerStatus: () => ({ open: false }),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: loggerWarnMock,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  collectReliabilityMetrics,
  serializeReliabilityMetrics,
} = await import('../../observability/reliabilityMetrics.js');

function zeroRowsFor(sql) {
  if (/FROM tenants\b/.test(sql)) return [{ id: '00000000-0000-4000-8000-000000000001' }];
  if (/FROM notification_outbox/.test(sql)) {
    return [{
      pending: 7,
      failed: 2,
      reconciliation_required: 1,
      dead_letter: 3,
      paused_rejected: 1,
      paused_uncertain: 2,
    }];
  }
  if (/FROM webhook_deliveries/.test(sql)) {
    return [{ pending: 0, failed: 0, dead: 0, in_flight: 0, stale_in_flight: 0, parked: 0 }];
  }
  if (/FROM pathway_projector_inbox\b/.test(sql) && /consumer_key = \$1/.test(sql)) {
    return [{ pending: 0, oldest_age: 0, leased: 0, dead: 0 }];
  }
  if (/FROM event_consumer_offsets offsets/.test(sql)) return [{ pending: 0 }];
  if (/WITH live_offsets AS/.test(sql)) {
    return [{ observed_at: 1_800_000_000, offsets_observed: 0, scopes: [] }];
  }
  if (/WITH pathway_keys/.test(sql)) return [];
  if (/WITH registry AS/.test(sql)) {
    return [{
      active_devices: 0,
      silent_devices: 0,
      unverified_rows: 0,
      active_associations: 0,
      unassociated_messages: 0,
      open_excursions: 0,
      suppressed: {},
    }];
  }
  return [];
}

describe('reliability metric family isolation', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    setTenantMock.mockReset();
    setTenantMock.mockImplementation(async (tenantId, callback) => callback({
      $queryRawUnsafe: (sql, ...params) => queryRawUnsafeMock(sql, tenantId, ...params),
    }));
    loggerWarnMock.mockReset();
    delete process.env.DATABASE_READ_URL;
  });

  it('refreshes healthy families but withholds freshness when one family fails', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM event_outbox/.test(sql)) throw new Error('event outbox read failed');
      return zeroRowsFor(sql);
    });

    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();

    const output = serializeReliabilityMetrics();
    expect(output).toContain('notification_outbox_pending_rows 7');
    expect(output).toContain('notification_delivery_paused_cursors{state="paused_uncertain"} 2');
    expect(output).not.toMatch(/^reliability_metrics_last_success_timestamp_seconds /m);
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining('event_outbox'));
  });

  it('emits a freshness timestamp only after every primary metric family succeeds', async () => {
    queryRawUnsafeMock.mockImplementation(async sql => zeroRowsFor(sql));

    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();

    const output = serializeReliabilityMetrics();
    expect(output).toMatch(/^reliability_metrics_last_success_timestamp_seconds \d+(?:\.\d+)?$/m);
  });

  it('aggregates notification gauges through explicit tenant contexts required by RLS', async () => {
    const tenantOne = '00000000-0000-4000-8000-000000000001';
    const tenantTwo = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafeMock.mockImplementation(async (sql, scopedTenant) => {
      if (/FROM tenants\b/.test(sql)) return [{ id: tenantOne }, { id: tenantTwo }];
      if (/FROM notification_outbox/.test(sql)) {
        return [{
          pending: scopedTenant === tenantOne ? 2 : 5,
          failed: scopedTenant === tenantOne ? 1 : 3,
          reconciliation_required: scopedTenant === tenantOne ? 0 : 1,
          dead_letter: scopedTenant === tenantOne ? 1 : 2,
          paused_rejected: scopedTenant === tenantOne ? 1 : 0,
          paused_uncertain: scopedTenant === tenantOne ? 0 : 2,
        }];
      }
      return zeroRowsFor(sql);
    });

    await collectReliabilityMetrics();

    expect(setTenantMock.mock.calls.map(([tenantId]) => tenantId)).toEqual([tenantOne, tenantTwo]);
    const output = serializeReliabilityMetrics();
    expect(output).toContain('notification_outbox_pending_rows 7');
    expect(output).toContain('notification_outbox_failed_rows 4');
    expect(output).toContain('notification_outbox_dead_letter_rows 3');
    expect(output).toContain('notification_delivery_paused_cursors{state="paused_uncertain"} 2');
  });
});
