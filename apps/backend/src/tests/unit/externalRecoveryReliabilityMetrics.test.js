import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  circuitBreakerStatus: () => ({ open: false }),
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock })
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: loggerWarnMock
  }
}));

const { __testing__, serializeReliabilityMetrics } =
  await import('../../observability/reliabilityMetrics.js');

const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000001';

function scope({
  tenantId = TENANT_A,
  facilityScope = 'facility',
  facilityId = 41,
  interfaceFamily = 'I10',
  direction = 'inbound',
  state = 'paused',
  pending = 0,
  pendingAge = 0,
  dead = 0,
  critical = 0,
  criticalAge = 0
} = {}) {
  return {
    tenant_id: tenantId,
    facility_scope: facilityScope,
    facility_id: facilityScope === 'tenant' ? null : facilityId,
    interface_family: interfaceFamily,
    direction,
    pending_rows: pending,
    oldest_pending_age_seconds: pendingAge,
    dead_rows: dead,
    unacknowledged_rows: critical,
    oldest_unacknowledged_age_seconds: criticalAge,
    states: [{ recovery_state: state, offset_count: 1 }]
  };
}

function observation(observedAt, scopes, offsetsObserved = scopes.length) {
  return [{ observed_at: observedAt, offsets_observed: offsetsObserved, scopes }];
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  loggerWarnMock.mockReset();
});

describe('external-recovery database-output metrics', () => {
  it('publishes I03 as tenant-wide without item-cardinality labels', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce(
      observation(1000, [
        scope({ pending: 4, pendingAge: 901, dead: 1, critical: 1, criticalAge: 120 }),
        scope({
          tenantId: TENANT_B,
          facilityScope: 'tenant',
          interfaceFamily: 'I03',
          state: 'replaying'
        })
      ])
    );

    await __testing__.collectExternalRecoveryOutputMetrics();

    const out = serializeReliabilityMetrics();
    expect(out).toContain(
      `external_recovery_inbox_pending_rows{tenant_id="${TENANT_A}",facility_scope="facility",facility_id="41",interface_family="I10",direction="inbound"} 4`
    );
    expect(out).toContain(
      `external_recovery_active_offsets{tenant_id="${TENANT_B}",facility_scope="tenant",facility_id="tenant-wide",interface_family="I03",direction="inbound",recovery_state="replaying"} 1`
    );
    const i03Series = out
      .split('\n')
      .filter((line) => line.includes('interface_family="I03"'));
    expect(i03Series.length).toBeGreaterThan(0);
    for (const series of i03Series) {
      expect(series).toContain(
        'facility_scope="tenant",facility_id="tenant-wide"'
      );
      expect(series).not.toMatch(/credential|control|patient|partition/);
    }
    expect(out).not.toMatch(/source_partition|offset_id|patient_uid|task_id|result_id/);
  });

  it('atomically replaces the complete snapshot, removes stale labels, and emits real zeros', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce(observation(2000, [scope({ facilityId: 41, pending: 7 })]))
      .mockResolvedValueOnce(
        observation(2060, [
          scope({
            tenantId: TENANT_B,
            facilityScope: 'tenant',
            interfaceFamily: 'I02',
            state: 'ready'
          })
        ])
      );

    await __testing__.collectExternalRecoveryOutputMetrics();
    await __testing__.collectExternalRecoveryOutputMetrics();

    const out = serializeReliabilityMetrics();
    expect(out).not.toContain(`tenant_id="${TENANT_A}"`);
    expect(out).toContain(
      `external_recovery_inbox_pending_rows{tenant_id="${TENANT_B}",facility_scope="tenant",facility_id="tenant-wide",interface_family="I02",direction="inbound"} 0`
    );
    expect(out).toContain('external_recovery_offsets_observed_total 1');
    expect(out).toContain('external_recovery_observation_timestamp_seconds 2060');
  });

  it('retains the prior complete snapshot after malformed or failed observations', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce(
      observation(3000, [scope({ facilityId: 42, critical: 1 })])
    );
    await __testing__.collectExternalRecoveryOutputMetrics();

    queryRawUnsafeMock.mockResolvedValueOnce(
      observation(3060, [scope({ tenantId: 'caller-selected-tenant' })])
    );
    await expect(__testing__.collectExternalRecoveryOutputMetrics()).rejects.toThrow(
      'invalid bounded labels'
    );
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('database output unavailable'));
    await expect(__testing__.collectExternalRecoveryOutputMetrics()).rejects.toThrow(
      'database output unavailable'
    );

    const out = serializeReliabilityMetrics();
    expect(out).toContain('external_recovery_observation_timestamp_seconds 3000');
    expect(out).toContain(`tenant_id="${TENANT_A}",facility_scope="facility",facility_id="42"`);
    expect(out).not.toContain('caller-selected-tenant');
  });

  it('reports a fresh zero total and no scoped series when no live offsets exist', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce(observation(4000, [], 0));

    await __testing__.collectExternalRecoveryOutputMetrics();

    const out = serializeReliabilityMetrics();
    expect(out).toContain('external_recovery_offsets_observed_total 0');
    expect(out).toContain('external_recovery_observation_timestamp_seconds 4000');
    expect(out).not.toMatch(/^external_recovery_inbox_pending_rows\{/m);
    expect(out).not.toMatch(/^external_recovery_active_offsets\{/m);
  });
});
